/**
 * `makeConnection({ url, token })` builds the Layer every renderer process
 * shares: a `Connection` supervisor plus the ambient `ConnectionState`.
 *
 * Effect's socket protocol is single-use by design — `SocketCloseError` is
 * broadcast to in-flight requests and the protocol stops — so reconnecting
 * means rebuilding the socket, the protocol and the `RpcClient` underneath
 * callers. `Connection.client` is the stable handle: it resolves to whichever
 * client is currently live, waiting through reconnects.
 *
 * The token travels on the upgrade query (`ws://host/ws?token=...`) because the
 * browser WebSocket API cannot set headers.
 *
 * Credentials are re-read per attempt, not captured once: the server binds an
 * ephemeral port and mints a new token every boot, so a supervisor restart
 * would otherwise leave the renderer looping against a dead port forever. For
 * the same reason `url`/`token` are optional — the desktop window opens while
 * the supervisor is still starting the server, and an attempt with nothing to
 * dial is a retry, not a dead end.
 */

import { OpenAdeRpcGroup } from "@OpenAde/contracts/rpc";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * What `connectionStateAtom` and the reconnecting banner show. `incompatible`
 * is terminal: the server speaks a different protocol version, so retrying is
 * pointless and one side has to be updated.
 */
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "incompatible";

export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Server's boot id — changes mean every cached snapshot is stale. */
  readonly serverInstanceId: string | null;
}

export class ConnectionStateRef extends Context.Service<
  ConnectionStateRef,
  SubscriptionRef.SubscriptionRef<ConnectionState>
>()("@OpenAde/client-runtime/ConnectionStateRef") {}

const makeClient = RpcClient.make(OpenAdeRpcGroup, { disableTracing: true });

/** The typed RPC client, as produced by `RpcClient.make(OpenAdeRpcGroup)`. */
export type OpenAdeRpcClient = Effect.Success<typeof makeClient>;

/**
 * The stable handle the atoms use. `client` is a per-call accessor: it awaits
 * the live client, so a subscriber that re-runs after a reconnect gets the new
 * one without ever holding a dead reference.
 */
export class Connection extends Context.Service<
  Connection,
  {
    readonly client: Effect.Effect<OpenAdeRpcClient>;
    readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>;
  }
>()("@OpenAde/client-runtime/Connection") {}

/**
 * What one connect attempt needs. Structurally the resolver's
 * `ResolvedConnection`, declared here so this module stays free of the
 * resolver's DOM types — `apps/server`'s transport test imports the layer and
 * typechecks without a `dom` lib.
 */
export interface ConnectionCredentials {
  /** `http(s)` or `ws(s)` URL including the `/ws` path. */
  readonly url: string;
  readonly token: string;
  /** The server's boot id, when the channel knows it. */
  readonly serverInstanceId?: string;
}

export interface ConnectionOptions {
  /**
   * `http(s)` or `ws(s)` URL including the `/ws` path.
   *
   * Optional, together with `token`: the desktop shell paints before the
   * server supervisor has bound a port, so the renderer builds this layer with
   * nothing but `resolve` and the attempt loop waits for the first channel
   * that answers. Omitting both without a `resolve` is a connection that can
   * never come up.
   */
  readonly url?: string;
  readonly token?: string;
  /**
   * Re-reads the credentials before every connect attempt. The server binds an
   * ephemeral port and mints a fresh token on each boot, so a supervisor that
   * restarts it leaves `url`/`token` stale; this effect goes back to the
   * source (preload state → the dev endpoint → the search params) so the next
   * attempt lands on the new server instead of looping against a dead port.
   *
   * It never fails: `null` means "no channel answered", and the last
   * credentials that did answer are reused — or, when none ever did, the
   * attempt is retried on the same backoff as a refused socket.
   */
  readonly resolve?: Effect.Effect<ConnectionCredentials | null>;
  /**
   * Overrides the WebSocket implementation — tests substitute a constructor
   * that records instances so they can force a disconnect.
   */
  readonly webSocketConstructor?: (
    url: string,
    protocols?: string | Array<string>,
  ) => globalThis.WebSocket;
}

const toWebSocketUrl = (url: string): string =>
  url.startsWith("http") ? `ws${url.slice(4)}` : url;

const INITIAL_BACKOFF = Duration.millis(100);
const MAX_BACKOFF = Duration.seconds(2);

/**
 * The attempt failure that means "no channel has answered yet". It travels the
 * same path as a refused socket — the loop backs off and tries again — so a
 * renderer that started before its server did converges on its own.
 */
const NO_CREDENTIALS = "no-credentials" as const;

interface Attempt {
  readonly client: OpenAdeRpcClient;
  readonly disconnected: Deferred.Deferred<void>;
}

/**
 * The one place a status moves, so the `incompatible` state is absorbing
 * everywhere. The subscribers that saw the mismatched hello are parked on
 * `Stream.never` and nothing re-runs them, so letting the supervisor's
 * ordinary `reconnecting → connected` cycle overwrite it would only make the
 * banner claim the app is live over a UI whose streams are all silent. Only
 * reloading the window — with the updated build — clears it.
 *
 * @public The supervisor and `markConnected` both go through this.
 */
export const setConnectionStatus = (
  state: SubscriptionRef.SubscriptionRef<ConnectionState>,
  status: ConnectionStatus,
) =>
  SubscriptionRef.update(state, (previous) =>
    previous.status === "incompatible" ? previous : { ...previous, status },
  );

/**
 * The boot id to keep after a connect attempt resolved `resolved`.
 *
 * Status moves on every socket drop; the boot id must not. Clearing it on a
 * plain reconnect would make each one look like a server restart and force a
 * full resnapshot of every subscription, so it is dropped only when the
 * channel actually reported a *different* id — a restarted server, whose
 * sequence numbers the client's cached snapshots do not belong to.
 *
 * `undefined` means the channel does not know the id (the `?server=` params
 * do not carry it), which is not evidence of a restart either.
 *
 * @public `makeConnection`'s attempt loop is the only caller; exported for the
 * unit test, since forcing a restart through a live socket needs a server.
 */
export const retainedInstanceId = (
  previous: string | null,
  resolved: string | undefined,
): string | null =>
  resolved === undefined || previous === null || previous === resolved ? previous : null;

export const makeConnection = (
  options: ConnectionOptions,
): Layer.Layer<Connection | ConnectionStateRef, never, Scope.Scope> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ConnectionState>({
        status: "connecting",
        serverInstanceId: null,
      });
      const current = yield* Ref.make(yield* Deferred.make<Attempt>());
      /**
       * The last credentials a channel actually answered with — `null` until
       * one has, which is the state the desktop renderer boots in while its
       * server supervisor is still starting.
       */
      const credentials = yield* Ref.make<ConnectionCredentials | null>(
        options.url === undefined || options.token === undefined
          ? null
          : { url: options.url, token: options.token },
      );

      /**
       * Status moves; the boot id does not. Clearing it on every drop would
       * make each reconnect look like a server restart and force a full
       * resnapshot — `attempt` clears it only when the id really changed.
       */
      const setStatus = (status: ConnectionStatus) => setConnectionStatus(state, status);

      /**
       * One connect attempt, built in the connection layer's scope — a child
       * scope here would starve the protocol's fibers, so dead attempts are
       * left to the ambient scope's finalizers instead.
       * `disconnected` completes when the socket's `onDisconnect` hook fires.
       */
      const attempt: Effect.Effect<Attempt, typeof NO_CREDENTIALS, Scope.Scope> = Effect.gen(
        function* () {
          const resolved = options.resolve === undefined ? null : yield* options.resolve;
          const active = resolved ?? (yield* Ref.get(credentials));
          if (active === null) {
            // Nothing to dial yet — the supervisor has not published a port.
            // That is an attempt that failed, not a connection that cannot
            // exist, so the loop backs off and asks the channel again.
            return yield* Effect.fail(NO_CREDENTIALS);
          }
          yield* Ref.set(credentials, active);
          // A restarted server is a different server: drop the remembered boot
          // id so every subscription resnapshots instead of resuming against a
          // sequence the new instance never issued.
          yield* SubscriptionRef.update(state, (previous) => {
            const retained = retainedInstanceId(previous.serverInstanceId, active.serverInstanceId);
            return retained === previous.serverInstanceId
              ? previous
              : { ...previous, serverInstanceId: retained };
          });
          const wsUrl = `${toWebSocketUrl(active.url)}?token=${encodeURIComponent(active.token)}`;
          const disconnected = yield* Deferred.make<void>();
          const socketLayer = Socket.layerWebSocket(wsUrl).pipe(
            Layer.provide(
              options.webSocketConstructor === undefined
                ? Socket.layerWebSocketConstructorGlobal
                : Layer.succeed(Socket.WebSocketConstructor, options.webSocketConstructor),
            ),
          );
          const protocolLayer = Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({
              // This supervisor owns the reconnect loop; the protocol fails
              // fast instead of retrying underneath it.
              retryTransientErrors: false,
              retryPolicy: Schedule.recurs(0),
            }),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                socketLayer,
                RpcSerialization.layerJson,
                Layer.succeed(RpcClient.ConnectionHooks, {
                  onConnect: Effect.void,
                  onDisconnect: Deferred.done(disconnected, Exit.void).pipe(Effect.asVoid),
                }),
              ),
            ),
          );
          const protocolContext = yield* Layer.build(protocolLayer);
          const client = yield* makeClient.pipe(Effect.provide(protocolContext));
          return { client, disconnected };
        },
      );

      const loop: Effect.Effect<void, never, Scope.Scope> = Effect.suspend(() => {
        let backoff = INITIAL_BACKOFF;
        const step: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
          const exit = yield* Effect.exit(attempt);
          if (Exit.isFailure(exit)) {
            yield* setStatus("reconnecting");
            yield* Effect.sleep(backoff);
            backoff = Duration.min(Duration.times(backoff, 2), MAX_BACKOFF);
            return;
          }
          const epoch: Attempt = exit.value;
          backoff = INITIAL_BACKOFF;
          // The installed deferred is already resolved: `.client` calls made
          // while connected return this epoch's client immediately instead of
          // hanging until the next reconnect resolves them.
          const resolved = yield* Deferred.make<Attempt>();
          yield* Deferred.succeed(resolved, epoch);
          const previous = yield* Ref.getAndSet(current, resolved);
          // Callers that grabbed the previous deferred during the reconnect
          // gap are still awaiting it — hand them this epoch's client too.
          yield* Deferred.succeed(previous, epoch);
          yield* setStatus("connected");
          yield* Deferred.await(epoch.disconnected);
          // This epoch is dead: put an unresolved deferred back so `.client`
          // calls wait for the next connect. The identity check keeps a late
          // disconnect from clobbering a newer epoch's resolved deferred.
          const pending = yield* Deferred.make<Attempt>();
          yield* Ref.update(current, (installed) => (installed === resolved ? pending : installed));
          yield* setStatus("reconnecting");
        });
        return step.pipe(Effect.forever);
      });

      yield* loop.pipe(Effect.forkScoped);

      /**
       * `.client` waits on whatever deferred `current` holds, then refuses to
       * hand out a client whose epoch is already dead — a socket can die in
       * the window between `onDisconnect` firing and the supervisor's
       * swap-back, so known-dead attempts loop until a live one is installed.
       */
      const client: Effect.Effect<OpenAdeRpcClient> = Effect.gen(function* () {
        for (;;) {
          const attempt = yield* Ref.get(current).pipe(Effect.flatMap(Deferred.await));
          if (!(yield* Deferred.isDone(attempt.disconnected))) {
            return attempt.client;
          }
          yield* Effect.yieldNow;
        }
      });

      return Layer.mergeAll(
        Layer.succeed(
          Connection,
          Connection.of({
            client,
            state,
          }),
        ),
        Layer.succeed(ConnectionStateRef, state),
      );
    }),
  );

/**
 * Records the boot id reported by `server.hello`. A build that already parked
 * on a protocol mismatch keeps that status: the parked subscribers never
 * un-park, so reporting `connected` would only hide the banner.
 */
export const markConnected = (serverInstanceId: string) =>
  ConnectionStateRef.use((state) =>
    SubscriptionRef.update(state, (previous) =>
      previous.status === "incompatible"
        ? previous
        : { status: "connected" as const, serverInstanceId },
    ),
  );

/**
 * The server answered `server.hello` with a protocol version this build does
 * not speak. Subscribing anyway would fail with opaque decode errors, so the
 * subscribers park and the banner asks for an update instead.
 *
 * Terminal by construction: `setStatus` and `markConnected` both refuse to
 * move off it, so an ordinary socket drop after the mismatch cannot put the
 * banner back to "connected" over a UI whose streams are all parked.
 */
export const markIncompatible = ConnectionStateRef.use((state) =>
  SubscriptionRef.update(state, (previous) => ({ ...previous, status: "incompatible" as const })),
);
