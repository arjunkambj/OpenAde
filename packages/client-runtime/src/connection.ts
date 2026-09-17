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

/** What `connectionStateAtom` and the reconnecting banner show. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

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

export interface ConnectionOptions {
  /** `http(s)` or `ws(s)` URL including the `/ws` path. */
  readonly url: string;
  readonly token: string;
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

interface Attempt {
  readonly client: OpenAdeRpcClient;
  readonly disconnected: Deferred.Deferred<void>;
}

export const makeConnection = (
  options: ConnectionOptions,
): Layer.Layer<Connection | ConnectionStateRef, never, Scope.Scope> => {
  const wsUrl = `${toWebSocketUrl(options.url)}?token=${encodeURIComponent(options.token)}`;

  return Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<ConnectionState>({
        status: "connecting",
        serverInstanceId: null,
      });
      const current = yield* Ref.make(yield* Deferred.make<OpenAdeRpcClient>());

      /**
       * One connect attempt, built in the connection layer's scope — a child
       * scope here would starve the protocol's fibers, so dead attempts are
       * left to the ambient scope's finalizers instead.
       * `disconnected` completes when the socket's `onDisconnect` hook fires.
       */
      const attempt: Effect.Effect<Attempt, never, Scope.Scope> = Effect.gen(function* () {
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
            // This supervisor owns the reconnect loop; the protocol fails fast
            // instead of retrying underneath it.
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
      });

      const loop: Effect.Effect<void, never, Scope.Scope> = Effect.suspend(() => {
        let backoff = INITIAL_BACKOFF;
        const step: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
          const exit = yield* Effect.exit(attempt);
          if (Exit.isFailure(exit)) {
            yield* SubscriptionRef.set(state, {
              status: "reconnecting",
              serverInstanceId: null,
            });
            yield* Effect.sleep(backoff);
            backoff = Duration.min(Duration.times(backoff, 2), MAX_BACKOFF);
            return;
          }
          const { client, disconnected } = exit.value;
          backoff = INITIAL_BACKOFF;
          const pending = yield* Deferred.make<OpenAdeRpcClient>();
          const previous = yield* Ref.getAndSet(current, pending);
          yield* Deferred.succeed(previous, client);
          yield* SubscriptionRef.set(state, {
            status: "connected",
            serverInstanceId: null,
          });
          yield* Deferred.await(disconnected);
          yield* SubscriptionRef.set(state, {
            status: "reconnecting",
            serverInstanceId: null,
          });
        });
        return step.pipe(Effect.forever);
      });

      yield* loop.pipe(Effect.forkScoped);

      return Layer.mergeAll(
        Layer.succeed(
          Connection,
          Connection.of({
            client: Ref.get(current).pipe(Effect.flatMap(Deferred.await)),
            state,
          }),
        ),
        Layer.succeed(ConnectionStateRef, state),
      );
    }),
  );
};

/** Records the boot id reported by `server.hello`. */
export const markConnected = (serverInstanceId: string) =>
  ConnectionStateRef.use((state) =>
    SubscriptionRef.set(state, { status: "connected", serverInstanceId }),
  );
