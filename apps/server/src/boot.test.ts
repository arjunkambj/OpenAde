/**
 * The composition root, built for real.
 *
 * Every other server test wires its own subset of the graph, so nothing used to
 * prove that the one `main.ts` ships holds together: that the handshake is
 * emitted, that the socket and the two loopback routes are mounted and guarded,
 * and — the defect this file was written for — that a connector the user adds
 * *after* boot is opened against the running app's endpoints rather than a
 * placeholder that dies on its first turn.
 *
 * Everything happens under a fresh `OPENADE_HOME`, and the connector points at
 * the fake Command Code executable, so no test here touches a real install.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeCommandId,
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
} from "@OpenAde/contracts/ids";
import type { Command } from "@OpenAde/contracts/orchestration";
import { defaultSettings } from "@OpenAde/contracts/settings";
import type { ConnectorInstanceConfig } from "@OpenAde/contracts/settings";
import { Connection, makeConnection } from "@OpenAde/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { boot, type BootedServer } from "./boot";
import { layer as sqliteLayer } from "./persistence/Sqlite";
import { SettingsStore } from "./rpc/services";

/** The stand-in CLI: `status --json`, `--list-models` and one print-mode turn. */
const FAKE_CMD = fileURLToPath(
  new URL("../../../packages/testkit/bin/fake-cmd.mjs", import.meta.url),
);

const MODEL = "stealth/ox-alpha";

interface Home {
  /** `OPENADE_HOME` for this boot. */
  readonly openade: string;
  /** `HOME` for the spawned CLI — its transcripts and `mcp.json` land here. */
  readonly cmd: string;
  /** A git repository to use as a project's workspace root. */
  readonly workspace: string;
}

const makeHome = (): Home => {
  const root = mkdtempSync(join(tmpdir(), "openade-boot-"));
  const workspace = join(root, "workspace");
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
  return { openade: join(root, "home"), cmd: join(root, "cmd-home"), workspace };
};

/**
 * Writes the settings row `boot` will find. Without one the connector manager
 * treats the home as a fresh install and seeds a `cmd` instance that probes the
 * machine's real binary — or, failing that, `npx`.
 */
const seedSettings = (home: Home, connectors: ReadonlyArray<ConnectorInstanceConfig>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sqlite = Layer.succeedContext(
        yield* Layer.build(sqliteLayer({ filename: join(home.openade, "state.sqlite") })),
      );
      const store = Context.get(
        yield* Layer.build(SettingsStore.layer.pipe(Layer.provide(sqlite))),
        SettingsStore,
      );
      yield* store.update({ ...defaultSettings(), connectors });
    }),
  );

const cmdConnector = (home: Home, displayName: string): ConnectorInstanceConfig => ({
  connectorInstanceId: makeConnectorInstanceId(),
  kind: "cmd",
  displayName,
  enabled: true,
  // `HOME` is both the fake CLI's transcript root and where the connector
  // writes `.commandcode/projects/<slug>/mcp.json`.
  config: { binaryPath: FAKE_CMD, extraEnv: { HOME: home.cmd } },
});

/** Boots the real graph in the test's scope and hands over the handshake. */
const booted = (home: Home) =>
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
  ).pipe(Effect.andThen(boot({ home: home.openade, dev: true, port: 0 })));

const client = (server: BootedServer) =>
  Layer.build(makeConnection({ url: server.url, token: server.token })).pipe(
    Effect.map((ctx) => Context.get(ctx, Connection)),
    Effect.flatMap((connection) => connection.client),
  );

const httpBase = (server: BootedServer) => server.url.replace(/^ws/, "http").replace(/\/ws$/, "");

const status = (url: string, init?: RequestInit) =>
  Effect.promise(() => fetch(url, init).then((response) => response.status));

/** Every `mcp.json` the connector wrote under the fake CLI's home. */
const mcpFiles = (home: Home): ReadonlyArray<string> => {
  const root = join(home.cmd, ".commandcode", "projects");
  try {
    return readdirSync(root).map((slug) => join(root, slug, "mcp.json"));
  } catch {
    return [];
  }
};

describe("boot", () => {
  it.live("emits the handshake and answers server.hello over a real socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);

        // Dev mode's handshake file is what the Vite plugin serves; it must
        // name the port that was actually bound, not the requested 0.
        const written: unknown = JSON.parse(
          readFileSync(join(home.openade, "dev", "connection.json"), "utf8"),
        );
        expect(written).toEqual(server);
        expect(server.url).not.toContain(":0/");

        const hello = yield* (yield* client(server))["server.hello"]({});
        expect(hello.serverInstanceId).toBe(server.serverInstanceId);
        expect(hello.protocolVersion).toBe(1);
      }),
    ),
  );

  it.live("guards the socket and both loopback routes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);
        const base = httpBase(server);
        const post = { method: "POST", body: "{}" } satisfies RequestInit;

        expect(yield* status(`${base}/ws?token=wrong`)).toBe(401);
        expect(yield* status(`${base}/ws`)).toBe(401);
        expect(yield* status(`${base}/mcp`, post)).toBe(401);
        expect(yield* status(`${base}/hooks/pretooluse`, post)).toBe(401);

        // Each path is mounted once and reaches its own handler: a second
        // registration of either would shadow one of these answers.
        expect(yield* status(`${base}/healthz`)).toBe(200);
        expect(yield* status(`${base}/mcp`)).toBe(405);
        expect(yield* status(`${base}/nope`)).toBe(404);
      }),
    ),
  );

  it.live("never re-seeds a home whose connectors the user removed", () =>
    Effect.gen(function* () {
      // Seeding is for a first run only, and "first run" is "no settings row",
      // not "no connectors": a user who deletes every connector has a row by
      // then. Guarding on the empty list instead put a `cmd` entry back on the
      // next start, which is what one owner of the connector lifecycle fixes.
      const home = makeHome();
      yield* seedSettings(home, []);

      const connectorsAfterBoot = Effect.scoped(
        Effect.gen(function* () {
          const server = yield* booted(home);
          return yield* (yield* client(server))["connectors.list"]({});
        }),
      );

      expect(yield* connectorsAfterBoot).toEqual([]);
      // The second boot is the one that used to resurrect it, over the very
      // same database the first one left behind.
      expect(yield* connectorsAfterBoot).toEqual([]);
    }),
  );

  it.live("opens a connector added after boot against the running app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);
        const rpc = yield* client(server);

        // The settings page's own path: write the instance, then refresh.
        const instance = cmdConnector(home, "Fake Command Code");
        yield* rpc["settings.update"]({ patch: { connectors: [instance] } });
        const listed = yield* rpc["connectors.list"]({ refresh: true });
        expect(listed).toHaveLength(1);
        expect(listed[0]!.probe.status).toBe("ready");
        // Opened, not merely configured: capabilities come from the instance.
        expect(listed[0]!.capabilities).not.toBeNull();

        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const dispatch = (command: Command) => rpc["orchestration.dispatch"]({ command });
        yield* dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "project.create",
          projectId,
          name: "boot",
          workspaceRoot: home.workspace,
        });
        yield* dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.create",
          threadId,
          projectId,
          settings: { model: MODEL },
        });
        yield* dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.turn.start",
          threadId,
          text: "hello",
          attachments: [],
          mentions: [],
          queued: false,
        });

        // A turn that completes is the proof: `send()` resolves the hook
        // endpoint without a guard, so a placeholder host would kill the fiber
        // here and this stream would never see the event.
        yield* rpc["threads.subscribe"]({ threadId }).pipe(
          Stream.filter(
            (item) => item.kind === "event" && item.event.type === "thread.turn.completed",
          ),
          Stream.runHead,
          Effect.timeout("60 seconds"),
        );

        // And the MCP endpoint resolved too: the session writes the gateway's
        // loopback url into the harness's own mcp.json.
        const files = mcpFiles(home);
        expect(files).toHaveLength(1);
        expect(readFileSync(files[0]!, "utf8")).toContain(`${httpBase(server)}/mcp`);
      }),
    ),
  );
});
