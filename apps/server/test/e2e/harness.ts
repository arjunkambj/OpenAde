/**
 * The end-to-end harness: one real server, one real client, one real CLI.
 *
 * Every other suite in the repo builds a subset — an engine over an in-memory
 * database, a connector with a stub host, a renderer fold over hand-made
 * events. This one builds the product: `boot()` from `apps/server/src/boot.ts`
 * assembles the same graph `main.ts` ships, `makeConnection` from
 * `@OpenAde/client-runtime` dials it over a real WebSocket, and the folds the
 * renderer's atoms use (`applyThreadStreamItem`, `applyThreadListItem`) turn
 * the subscription into the very view a pane renders. What the assertions look
 * at is therefore what a user would see.
 *
 * Underneath sits one of two drivers, and that is the only difference between
 * a live run and the gate's:
 *
 * - `liveDriver` lets the connector discover the operator's own `cmd` and
 *   spends their plan. It is opt-in (`OPENADE_LIVE_CMD=1`).
 * - `replayDriver` points the connector's binary path at testkit's replayer,
 *   which puts a recording of that same run back on the wire. It is what runs
 *   in the gate.
 *
 * Nothing waits on a clock. Commands are awaited through their receipts and
 * everything else through the subscription, so a scenario that never happens
 * ends as a failed `awaitItem` rather than a slow pass.
 *
 * Safety: every test gets a fresh `OPENADE_HOME` and a throwaway git repo
 * under the system temp directory, so nothing here can touch the operator's
 * real `~/.openade`. The replay driver also redirects `HOME`, so it cannot
 * touch `~/.commandcode` either; the live driver deliberately does not, since
 * that is where the CLI's credentials live — the only thing it writes there is
 * the session record the CLI writes for any run.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  applyThreadListItem,
  applyThreadStreamItem,
  type ThreadDetailView,
} from "@OpenAde/client-runtime/clientState";
import {
  Connection,
  makeConnection,
  type ConnectionCredentials,
  type OpenAdeRpcClient,
} from "@OpenAde/client-runtime/connection";
import { makeStreamCollector, type StreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeCommandId, makeConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type {
  Command,
  CommandReceipt,
  ThreadStreamItem,
  ThreadSummary,
} from "@OpenAde/contracts/orchestration";
import { defaultSettings } from "@OpenAde/contracts/settings";
import type { ConnectorInstanceConfig } from "@OpenAde/contracts/settings";
import { replayConfig } from "@OpenAde/testkit/replayCmdProcess";
import { describe, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { boot, type BootedServer } from "../../src/boot";
import { layer as sqliteLayer } from "../../src/persistence/Sqlite";
import { SettingsStore } from "../../src/rpc/services";

/**
 * The model every scenario runs on.
 *
 * `cmd --list-models` offers about seventy and most of them bill the
 * operator's card. Three are authorised for spending; this is the account
 * default, which is also the one every recording under
 * `packages/testkit/fixtures/cmd/` was made on, so the live and replay drivers
 * name the same model and `recordedArgs.test.ts` keeps them honest.
 */
export const E2E_MODEL = "meta/muse-spark-1.3-contributor";

/** Whether the live driver may spend the operator's plan. */
export const LIVE = process.env.OPENADE_LIVE_CMD === "1";

// ── Homes ──────────────────────────────────────────────────────

export interface E2EHome {
  /** The temp root everything below hangs off; removed with the scope. */
  readonly root: string;
  /** `OPENADE_HOME` for this boot: database, attachments, hook script. */
  readonly openade: string;
  /** A `HOME` for anything the replay driver spawns. */
  readonly cmdHome: string;
  /** A git repository to use as the project's workspace root. */
  readonly workspace: string;
}

/** Seeds a throwaway git repo so the harness sees an ordinary workspace. */
const initWorkspace = (workspace: string, seed: Readonly<Record<string, string>>): void => {
  NodeFS.mkdirSync(workspace, { recursive: true });
  for (const [name, content] of Object.entries(seed)) {
    NodeFS.writeFileSync(NodePath.join(workspace, name), content, "utf8");
  }
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "e2e@example.invalid"],
    ["config", "user.name", "e2e"],
    ["add", "-A"],
    ["commit", "-q", "-m", "seed", "--allow-empty"],
  ]) {
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  }
};

/**
 * A fresh home bound to the calling scope. `seed` is written into the
 * workspace and committed, so a checkpoint diff has something to be a diff of.
 */
export const makeHome = (
  label: string,
  seed: Readonly<Record<string, string>> = {},
): Effect.Effect<E2EHome, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `openade-e2e-${label}-`)),
      ),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const home: E2EHome = {
      root,
      openade: NodePath.join(root, "openade"),
      cmdHome: NodePath.join(root, "cmd-home"),
      workspace: NodePath.join(root, "workspace"),
    };
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(home.openade, { recursive: true });
      NodeFS.mkdirSync(home.cmdHome, { recursive: true });
      initWorkspace(home.workspace, seed);
    });
    return home;
  });

// ── Drivers ────────────────────────────────────────────────────

export interface Driver {
  readonly name: "live" | "replay";
  /**
   * The connector instance a scenario runs on. `recording` names the fixture
   * the replay driver plays back; the live driver ignores it and discovers the
   * operator's own `cmd` exactly as the shipped product does.
   */
  readonly connector: (home: E2EHome, recording: string) => ConnectorInstanceConfig;
}

/**
 * The real CLI. `binaryPath` is deliberately absent so `probe.ts`'s own
 * discovery runs — finding `cmd` on PATH is part of what a live run proves —
 * and `extraEnv` is empty so the child inherits the operator's `HOME`, which
 * is where the CLI keeps its credentials.
 */
export const liveDriver: Driver = {
  name: "live",
  connector: () => ({
    connectorInstanceId: makeConnectorInstanceId(),
    kind: "cmd",
    displayName: "Command Code",
    enabled: true,
    config: {},
  }),
};

/** The same connector, spawning a recording instead of a model. */
export const replayDriver: Driver = {
  name: "replay",
  connector: (home, recording) => {
    const replay = replayConfig(recording, { home: home.cmdHome });
    return {
      connectorInstanceId: makeConnectorInstanceId(),
      kind: "cmd",
      displayName: "Command Code",
      enabled: true,
      config: { binaryPath: replay.binaryPath, extraEnv: replay.extraEnv },
    };
  },
};

/** Both drivers, with the live one skipped unless it is turned on. */
export const drivers: ReadonlyArray<Driver> = [replayDriver, liveDriver];

/**
 * Runs one scenario body against both drivers.
 *
 * The same assertions run twice: once against a recording, which is what the
 * gate does, and once against the real CLI, which is what says the recording
 * still describes reality. A scenario that needs different expectations from
 * the two is a scenario whose recording has gone stale.
 *
 * A live turn is a model round trip — seconds, not the five vitest allows — so
 * turning the live driver on also lifts the timeout for the whole file.
 */
export const forEachDriver = (title: string, body: (driver: Driver) => void): void => {
  for (const driver of drivers) {
    if (driver.name === "live" && !LIVE) {
      describe.skip(`${title} [live]`, () => {
        it("is only run with OPENADE_LIVE_CMD=1 — it spends the operator's plan", () => {
          // Intentionally empty: the skip itself is the statement.
        });
      });
      continue;
    }
    // Even a replay is several real processes, a real socket and a real
    // database, and a multi-turn scenario spawns the replayer once per turn —
    // comfortably past the five seconds vitest allows by default. A live turn
    // is a model round trip on top of that.
    vi.setConfig({
      testTimeout: driver.name === "live" ? 600_000 : 120_000,
      hookTimeout: 120_000,
    });
    describe(`${title} [${driver.name}]`, () => body(driver));
  }
};

// ── The server ─────────────────────────────────────────────────

/**
 * Writes the settings row `boot` will find.
 *
 * Without one the connector manager treats the home as a fresh install and
 * seeds its own `cmd` instance — which is right for a first run and wrong for
 * a test, because then the test cannot say which binary the instance points
 * at.
 */
export const seedSettings = (
  home: E2EHome,
  connectors: ReadonlyArray<ConnectorInstanceConfig>,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sqlite = Layer.succeedContext(
        yield* Layer.build(sqliteLayer({ filename: NodePath.join(home.openade, "state.sqlite") })),
      );
      const store = Context.get(
        yield* Layer.build(SettingsStore.layer.pipe(Layer.provide(sqlite))),
        SettingsStore,
      );
      yield* store.update({ ...defaultSettings(), connectors });
    }),
  ).pipe(Effect.orDie);

/**
 * Boots the real graph in the calling scope and restores `OPENADE_HOME` when
 * it closes — `boot` sets the variable process-wide on purpose, so that
 * spawned children inherit it, and a test must not leave it pointing at a
 * directory it is about to delete.
 */
export const bootServer = (home: E2EHome, options: { readonly dev?: boolean } = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => process.env.OPENADE_HOME),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.OPENADE_HOME;
        } else {
          process.env.OPENADE_HOME = previous;
        }
      }),
  ).pipe(
    Effect.andThen(boot({ home: home.openade, dev: options.dev ?? false, port: 0 })),
    Effect.orDie,
  );

// ── The client ─────────────────────────────────────────────────

export interface E2EClient {
  readonly rpc: OpenAdeRpcClient;
  /** Dispatches and returns the receipt, so a caller can wait for its write. */
  readonly dispatch: (command: Command) => Effect.Effect<CommandReceipt>;
  /** Dispatches and fails the test if the server rejected the command. */
  readonly send: (command: Command) => Effect.Effect<CommandReceipt>;
}

/**
 * A client on the running server.
 *
 * `credentials` is an effect rather than a value because the crash-and-restart
 * scenario needs the renderer's real behaviour: the server binds an ephemeral
 * port and mints a new token every boot, so `makeConnection` re-reads its
 * credentials before every attempt and lands on the new server instead of
 * looping against a dead port.
 */
export const connect = (
  credentials: Effect.Effect<ConnectionCredentials | null>,
): Effect.Effect<E2EClient, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const first = yield* credentials;
    const context = yield* Layer.build(
      makeConnection({
        ...(first === null ? {} : { url: first.url, token: first.token }),
        resolve: credentials,
      }),
    );
    const rpc = yield* Context.get(context, Connection).client;
    const dispatch = (command: Command): Effect.Effect<CommandReceipt> =>
      rpc["orchestration.dispatch"]({ command }).pipe(Effect.orDie);
    return {
      rpc,
      dispatch,
      send: (command) =>
        dispatch(command).pipe(
          Effect.flatMap((receipt) =>
            receipt.status === "accepted"
              ? Effect.succeed(receipt)
              : Effect.die(
                  new Error(`${command.type} was rejected: ${receipt.reason ?? "no reason given"}`),
                ),
          ),
        ),
    };
  });

/** The credentials of one booted server, for `connect`. */
export const staticCredentials = (server: BootedServer): ConnectionCredentials => ({
  url: server.url,
  token: server.token,
  serverInstanceId: server.serverInstanceId,
});

// ── Commands ───────────────────────────────────────────────────

type CommandBody<T extends Command["type"]> = Omit<
  Extract<Command, { readonly type: T }>,
  "commandId" | "createdAt"
>;

/**
 * Builds a command with a fresh id and timestamp, so a scenario reads as the
 * user's intent rather than as bookkeeping.
 */
export const command = <T extends Command["type"]>(body: CommandBody<T>): Command =>
  ({
    commandId: makeCommandId(),
    createdAt: new Date().toISOString(),
    ...body,
  }) as Command;

// ── Watching a thread the way the renderer does ────────────────

/**
 * A position in the sequence of views, for waits that mean "after this".
 *
 * Without one, "wait for a view with no approval pending" is answered by a
 * view from *before* the thing being tested — the collector searches its whole
 * history, which is what makes it able to resolve an event that already
 * happened. Every scenario here has a before and an after, so every wait takes
 * a mark.
 */
export type ViewMark = number;

export interface ThreadWatch {
  /** Every view the fold produced, in order. */
  readonly views: Effect.Effect<ReadonlyArray<ThreadDetailView>>;
  /** The position after the views seen so far; pass it to `awaitView`. */
  readonly mark: Effect.Effect<ViewMark>;
  /**
   * Waits until the subscription has caught up with one command's own write,
   * and answers with the position just after the view that carried it.
   *
   * This is what `CommandReceipt.lastSequence` is for: it names the event-log
   * position the command's effects are visible at, so "the turn I just started
   * is on screen" is an exact question rather than a race. Every later wait in
   * a scenario starts from the mark it returns.
   */
  readonly markAfter: (receipt: CommandReceipt) => Effect.Effect<ViewMark>;
  /** The latest view; fails if the subscription ended before one arrived. */
  readonly latest: Effect.Effect<ThreadDetailView>;
  /**
   * Resolves with the first view at or after `after` satisfying `predicate`.
   * Omitting `after` searches from the beginning, which is right only for the
   * first wait of a scenario.
   */
  readonly awaitView: (
    predicate: (view: ThreadDetailView) => boolean,
    after?: ViewMark,
  ) => Effect.Effect<ThreadDetailView>;
  /** The views from `after` onwards — for "nothing happened in between". */
  readonly viewsSince: (after: ViewMark) => Effect.Effect<ReadonlyArray<ThreadDetailView>>;
  /** The raw stream items, for assertions about delivery rather than state. */
  readonly items: Effect.Effect<ReadonlyArray<ThreadStreamItem>>;
}

/** One view and where it sat in the sequence. */
interface MarkedView {
  readonly index: ViewMark;
  readonly view: ThreadDetailView;
}

/**
 * Subscribes to a thread and folds it exactly as `threadDetailAtom` does.
 *
 * The fold is the renderer's — `applyThreadStreamItem` from
 * `@OpenAde/client-runtime` — so a bug that would show as a wrong pane shows
 * here as a wrong view. `describe` is used in the failure message when a wait
 * outlives its subscription, because "the stream ended" says nothing on its
 * own about which wait was outstanding.
 */
export const watchThread = (
  client: E2EClient,
  threadId: ThreadId,
): Effect.Effect<ThreadWatch, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const raw = yield* Ref.make<ReadonlyArray<ThreadStreamItem>>([]);
    const doc = yield* Ref.make<ThreadDetailView | null>(null);
    const seen = yield* Ref.make<ViewMark>(0);
    const stream = client.rpc["threads.subscribe"]({ threadId }).pipe(
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          yield* Ref.update(raw, (all) => [...all, item]);
          if (item.kind === "resnapshot-required") {
            yield* Ref.set(doc, null);
          }
          const view = yield* Ref.updateAndGet(doc, (current) =>
            applyThreadStreamItem(current, item),
          );
          if (view === null) {
            return null;
          }
          const index = yield* Ref.getAndUpdate(seen, (count) => count + 1);
          return { index, view } satisfies MarkedView;
        }),
      ),
      Stream.filter((marked): marked is MarkedView => marked !== null),
      Stream.orDie,
    );
    const collector: StreamCollector<MarkedView> = yield* makeStreamCollector(stream);
    const awaitMarked = (
      predicate: (view: ThreadDetailView) => boolean,
      after: ViewMark = 0,
    ): Effect.Effect<MarkedView> =>
      collector
        .awaitItem((marked) => marked.index >= after && predicate(marked.view))
        .pipe(
          Effect.catchTag("StreamEnded", (error) =>
            Effect.die(
              new Error(
                `the thread subscription ended after ${error.seen} views without one matching the wait (from mark ${after})`,
              ),
            ),
          ),
        );
    const awaitView = (
      predicate: (view: ThreadDetailView) => boolean,
      after: ViewMark = 0,
    ): Effect.Effect<ThreadDetailView> =>
      awaitMarked(predicate, after).pipe(Effect.map((marked) => marked.view));
    const views = collector.collected.pipe(Effect.map((all) => all.map((marked) => marked.view)));
    return {
      views,
      mark: Ref.get(seen),
      markAfter: (receipt) =>
        awaitMarked((view) => view.snapshotSequence >= receipt.lastSequence).pipe(
          Effect.map((marked) => marked.index + 1),
        ),
      latest: views.pipe(Effect.map((all) => all.at(-1)!)),
      awaitView,
      viewsSince: (after) =>
        collector.collected.pipe(
          Effect.map((all) =>
            all.filter((marked) => marked.index >= after).map((marked) => marked.view),
          ),
        ),
      items: Ref.get(raw),
    };
  });

export interface ListWatch {
  /** The position after the updates seen so far; pass it to `awaitList`. */
  readonly mark: Effect.Effect<ViewMark>;
  readonly awaitList: (
    predicate: (threads: ReadonlyArray<ThreadSummary>) => boolean,
    after?: ViewMark,
  ) => Effect.Effect<ReadonlyArray<ThreadSummary>>;
  readonly latest: Effect.Effect<ReadonlyArray<ThreadSummary>>;
}

/** One list state and where it sat in the sequence. */
interface MarkedList {
  readonly index: ViewMark;
  readonly threads: ReadonlyArray<ThreadSummary>;
}

/** The sidebar's own subscription, folded with the sidebar's own reducer. */
export const watchThreadList = (
  client: E2EClient,
  projectId: ProjectId,
): Effect.Effect<ListWatch, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<ThreadSummary>>([]);
    const seen = yield* Ref.make<ViewMark>(0);
    const stream = client.rpc["threads.listSubscribe"]({ projectId }).pipe(
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          const threads = yield* Ref.updateAndGet(state, (current) =>
            applyThreadListItem(current, item),
          );
          const index = yield* Ref.getAndUpdate(seen, (count) => count + 1);
          return { index, threads } satisfies MarkedList;
        }),
      ),
      Stream.orDie,
    );
    const collector: StreamCollector<MarkedList> = yield* makeStreamCollector(stream);
    const awaitList = (
      predicate: (threads: ReadonlyArray<ThreadSummary>) => boolean,
      after: ViewMark = 0,
    ): Effect.Effect<ReadonlyArray<ThreadSummary>> =>
      collector
        .awaitItem((marked) => marked.index >= after && predicate(marked.threads))
        .pipe(
          Effect.map((marked) => marked.threads),
          Effect.catchTag("StreamEnded", (error) =>
            Effect.die(
              new Error(
                `the thread list ended after ${error.seen} updates without one matching the wait (from mark ${after})`,
              ),
            ),
          ),
        );
    return {
      mark: Ref.get(seen),
      awaitList,
      latest: collector.collected.pipe(Effect.map((all) => all.at(-1)?.threads ?? [])),
    };
  });

// ── Reading a view ─────────────────────────────────────────────

/** Every assistant message in the view, joined — what the transcript says. */
export const assistantText = (view: ThreadDetailView): string =>
  view.items
    .filter((item) => item.kind === "assistant_message")
    .map((item) => item.text ?? "")
    .join(" ");

/** The timeline rows of one kind, oldest first. */
export const itemsOfKind = (
  view: ThreadDetailView,
  kind: string,
): ReadonlyArray<ThreadDetailView["items"][number]> =>
  view.items.filter((item) => item.kind === kind);

/** True once the thread has no turn running and nothing waiting on the user. */
export const isSettled = (view: ThreadDetailView): boolean =>
  view.currentTurnId === null &&
  view.pendingApproval === null &&
  view.pendingUserInput === null &&
  view.pendingPlan === null;
