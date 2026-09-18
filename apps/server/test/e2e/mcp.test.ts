/**
 * Scenario (j): OpenAde's own tools, offered to the harness.
 *
 * The browser tools are not built into Command Code — they are ours, served
 * over an MCP endpoint the running app mounts per thread. For the model to be
 * able to call them, three things have to line up while a session is open: the
 * gateway has to be listening with a per-session bearer, the connector has to
 * have written an `openade` entry into the project's `mcp.json`, and that
 * entry has to name the endpoint the gateway is actually on.
 *
 * The entry is written into a file the user owns, so the same rule applies as
 * everywhere else: merge, mark what is ours, and put it back when the session
 * closes.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  bootServer,
  connect,
  forEachDriver,
  isSettled,
  makeHome,
  openThread,
  seedSettings,
  startTurn,
  staticCredentials,
  type Driver,
  type E2EHome,
} from "./harness";

/** Every `mcp.json` under the temp harness home, whatever slug it was filed under. */
const mcpEntries = (home: E2EHome): ReadonlyArray<Record<string, unknown>> => {
  const root = NodePath.join(home.cmdHome, ".commandcode", "projects");
  let dirs: ReadonlyArray<string>;
  try {
    dirs = NodeFS.readdirSync(root);
  } catch {
    return [];
  }
  return dirs.flatMap((dir) => {
    try {
      const parsed = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, dir, "mcp.json"), "utf8"),
      ) as { mcpServers?: Record<string, unknown> };
      return parsed.mcpServers === undefined ? [] : [parsed.mcpServers];
    } catch {
      return [];
    }
  });
};

const gateway = (driver: Driver) => {
  it.live("advertises our MCP server to the harness while a session is open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("mcp", { "note.txt": "hello\n" });
        yield* seedSettings(home, [driver.connector(home, "text")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home);

        // Nothing is written until a session exists: the endpoint is
        // per-thread and the bearer is per-session, so there is nothing
        // truthful to write before one is open.
        expect(mcpEntries(home)).toEqual([]);

        const started = yield* startTurn(client, open, { text: "Reply with exactly: ok" });
        const done = yield* open.view.awaitValue(isSettled, started);
        expect(done.session).not.toBeNull();

        const entries = mcpEntries(home);
        expect(entries.length).toBeGreaterThan(0);
        const ours = entries.find((servers) => "openade" in servers);
        expect(ours, "no `openade` entry in any project mcp.json").toBeDefined();

        const entry = ours!["openade"] as Record<string, unknown>;
        // An http transport pointing at this server's own gateway. The entry's
        // *name* is the ownership marker — teardown reverts `openade` and
        // nothing else, so a server the user added under another name survives
        // whatever OpenAde does to this file.
        expect(entry["transport"]).toBe("http");
        expect(entry["enabled"]).toBe(true);
        expect(String(entry["url"])).toContain("127.0.0.1");

        // The per-session bearer stays a placeholder on disk: the harness
        // resolves env references at launch (spec 5.6), and a real token in a
        // file in the user's project would outlive the session that minted it.
        const serialized = JSON.stringify(entry);
        expect(serialized).toContain("OPENADE_MCP_TOKEN");
        expect(serialized).toContain("${");

        // The gateway itself is up and refuses anyone without the bearer —
        // which is what makes writing the url into a user's project safe.
        const base = server.url.replace(/^ws/, "http").replace(/\/ws$/, "");
        const status = yield* Effect.promise(() =>
          fetch(`${base}/mcp`, { method: "POST", body: "{}" }).then((response) => response.status),
        );
        expect(status).toBe(401);
      }),
    ),
  );
};

forEachDriver("the MCP gateway", gateway);
