/**
 * Scenario (j): Poseidon's own tools, offered to the harness.
 *
 * The browser tools are not built into Command Code — they are ours, served
 * over an MCP endpoint the running app mounts per thread. For the model to be
 * able to call them, three things have to line up while a session is open: the
 * gateway has to be listening with a per-session bearer, an `poseidon` entry
 * has to exist in the harness's *local* MCP scope for this project, and that
 * entry has to name the endpoint the gateway is actually on.
 *
 * The second of those is the one that was wrong. That file lives under a slug
 * of the workspace path that only the CLI knows how to spell, the connector
 * used to spell it itself, and it spelled it differently — so the entry sat in
 * a directory the harness never read and the model was never offered a single
 * browser tool. The scenario looks the entry up by the url it must contain
 * rather than by a path the test would have to guess in turn, which is the
 * same reason the connector now asks the CLI to write it.
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
} from "./harness";

/**
 * The project directories under a harness home that hold an `poseidon` MCP
 * entry naming `url`.
 *
 * Searching by url rather than by directory is the point: the live driver
 * writes into the operator's own `~/.commandcode`, which holds a project
 * directory per session they have ever run, and the gateway's port is unique
 * to this server.
 */
const entriesNaming = (harnessHome: string, url: string): ReadonlyArray<string> => {
  const root = NodePath.join(harnessHome, ".commandcode", "projects");
  let dirs: ReadonlyArray<string>;
  try {
    dirs = NodeFS.readdirSync(root);
  } catch {
    return [];
  }
  return dirs.filter((dir) => {
    try {
      const parsed = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, dir, "mcp.json"), "utf8"),
      ) as { mcpServers?: Record<string, { url?: string }> };
      return parsed.mcpServers?.["poseidon"]?.url === url;
    } catch {
      return false;
    }
  });
};

const gateway = (driver: Driver) => {
  it.live("registers our MCP server while a session is open, and takes it back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("mcp", { "note.txt": "hello\n" });
        yield* seedSettings(home, [driver.connector(home, "text")]);
        const harnessHome = driver.harnessHome(home);

        const endpoint = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* bootServer(home);
            const client = yield* connect(Effect.succeed(staticCredentials(server)));
            const open = yield* openThread(client, home);

            const started = yield* startTurn(client, open, { text: "Reply with exactly: ok" });
            const done = yield* open.view.awaitValue(isSettled, started);
            expect(done.session).not.toBeNull();

            // The endpoint the gateway is really on, port and all.
            const base = server.url.replace(/^ws/, "http").replace(/\/ws$/, "");
            const url = `${base}/mcp`;

            // Registered, and in a directory the harness itself chose.
            const found = entriesNaming(harnessHome, url);
            expect(found, `no poseidon entry naming ${url}`).toHaveLength(1);

            const entry = (
              JSON.parse(
                NodeFS.readFileSync(
                  NodePath.join(harnessHome, ".commandcode", "projects", found[0]!, "mcp.json"),
                  "utf8",
                ),
              ) as { mcpServers: Record<string, Record<string, unknown>> }
            ).mcpServers["poseidon"]!;
            expect(entry["transport"]).toBe("http");
            expect(entry["enabled"]).toBe(true);
            // The per-session bearer stays a placeholder on disk: the harness
            // resolves env references at launch, and a real token in
            // a file in the user's project would outlive the session that
            // minted it.
            const serialized = JSON.stringify(entry);
            expect(serialized).toContain("POSEIDON_MCP_TOKEN");
            expect(serialized).toContain("${");

            // The gateway is up and refuses anyone without the bearer — which
            // is what makes writing its url into a user's project safe at all.
            const status = yield* Effect.promise(() =>
              fetch(`${base}/mcp`, { method: "POST", body: "{}" }).then(
                (response) => response.status,
              ),
            );
            expect(status).toBe(401);
            return url;
          }),
        );

        // The session is over, and so is the entry: a loopback url for a port
        // nothing is listening on is worse than no entry at all, and it is in
        // a file the user owns.
        expect(entriesNaming(harnessHome, endpoint)).toEqual([]);
      }),
    ),
  );
};

forEachDriver("the MCP gateway", gateway);
