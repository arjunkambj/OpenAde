/**
 * Scenario (h): the settings pages, against the user's real files.
 *
 * Two of the files OpenAde writes belong to the user — Command Code's own
 * config — and the rule for both is the same: merge into what is there, own
 * only what is marked as ours, and leave everything else exactly as found. A
 * settings page that quietly replaced a hand-edited config would be the worst
 * kind of bug, because the user would not find out until the next time they
 * needed what it had removed.
 *
 * The rest of the file is the connectors page: the model list comes from the
 * connector rather than from a constant, and an instance added after boot is
 * probed and opened by the running app rather than at the next restart.
 *
 * `commandCodeHome` is redirected for the whole boot, so nothing here touches
 * the operator's real `~/.commandcode` — including under the live driver,
 * where the sessions themselves still use the real one for credentials.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  bootServer,
  connect,
  E2E_MODEL,
  forEachDriver,
  makeHome,
  seedSettings,
  staticCredentials,
  type Driver,
} from "./harness";

const settings = (driver: Driver) => {
  it.live("adds an MCP server to the harness config without disturbing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("settings-mcp");
        yield* seedSettings(home, [driver.connector(home, "text")]);

        // Something of the user's, written before OpenAde ever ran.
        const configDir = NodePath.join(home.cmdHome, ".commandcode");
        const userMcp = NodePath.join(configDir, "mcp.json");
        yield* Effect.sync(() => {
          NodeFS.mkdirSync(configDir, { recursive: true });
          NodeFS.writeFileSync(
            userMcp,
            JSON.stringify(
              { mcpServers: { theirs: { type: "stdio", command: "their-tool" } } },
              null,
              2,
            ),
            "utf8",
          );
        });

        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const rpc = yield* client.rpc;

        const after = yield* rpc["cmdConfig.mcp.upsert"]({
          server: {
            name: "ours",
            scope: "user",
            enabled: true,
            transport: "stdio",
            command: "our-tool",
            args: ["--serve"],
          },
        }).pipe(Effect.orDie);

        // The RPC answers with the whole list, ours and theirs.
        expect(after.map((entry) => entry.name).sort()).toEqual(["ours", "theirs"]);
        const ours = after.find((entry) => entry.name === "ours")!;
        // Ownership is what makes it editable from the page at all.
        expect(ours.managed).toBe(true);
        expect(after.find((entry) => entry.name === "theirs")!.managed ?? false).toBe(false);

        // And on disk: our entry is in the file, and theirs is untouched.
        const raw = yield* Effect.sync(() => NodeFS.readFileSync(userMcp, "utf8"));
        const parsed = JSON.parse(raw) as {
          mcpServers: Record<string, Record<string, unknown>>;
        };
        expect(parsed.mcpServers["theirs"]).toEqual({ type: "stdio", command: "their-tool" });
        expect(parsed.mcpServers["ours"]).toBeDefined();
        // The marker is the ownership record — without it the next version of
        // OpenAde has no way to tell its own entry from the user's.
        expect(JSON.stringify(parsed.mcpServers["ours"])).toContain("_openade");

        // Removing ours puts the file back the way the user had it.
        const removed = yield* rpc["cmdConfig.mcp.remove"]({ scope: "user", name: "ours" }).pipe(
          Effect.orDie,
        );
        expect(removed.map((entry) => entry.name)).toEqual(["theirs"]);
        const afterRemove = JSON.parse(
          yield* Effect.sync(() => NodeFS.readFileSync(userMcp, "utf8")),
        ) as { mcpServers: Record<string, unknown> };
        expect(Object.keys(afterRemove.mcpServers)).toEqual(["theirs"]);
      }),
    ),
  );

  it.live("answers with the connector's own models and opens an instance added after boot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("settings-connectors");
        const first = driver.connector(home, "text");
        yield* seedSettings(home, [first]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const rpc = yield* client.rpc;

        // The model list is the connector's, not a constant: it is what
        // `cmd --list-models` said, so the picker cannot offer a model the
        // installed CLI does not have.
        const models = yield* rpc["connectors.models"]({
          instanceId: first.connectorInstanceId,
        }).pipe(Effect.orDie);
        expect(models.length).toBeGreaterThan(0);
        expect(models.map((model) => model.id)).toContain(E2E_MODEL);

        const listed = yield* rpc["connectors.list"]({}).pipe(Effect.orDie);
        expect(listed).toHaveLength(1);
        expect(listed[0]!.probe.status).toBe("ready");

        // The settings page's own path: write the instance, then refresh. The
        // defect this covers is an entry the running app never picks up — one
        // that stays "Probing…" forever, or is configured but never opened, so
        // the first turn on it fails with `NoConnector`.
        const second = { ...driver.connector(home, "text"), displayName: "A second one" };
        yield* rpc["settings.update"]({ patch: { connectors: [first, second] } }).pipe(
          Effect.orDie,
        );
        const both = yield* rpc["connectors.list"]({ refresh: true }).pipe(Effect.orDie);
        expect(both).toHaveLength(2);
        const added = both.find(
          (entry) => entry.connectorInstanceId === second.connectorInstanceId,
        )!;
        expect(added.probe.status).toBe("ready");
        // Opened, not merely configured: capabilities come from the instance.
        expect(added.capabilities).not.toBeNull();
      }),
    ),
  );

  it.live("keeps a connector the user removed removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The settings document is the truth, and it survives a restart. A
        // home that seeds itself again on the next boot would put back an
        // instance the user deliberately deleted.
        const home = yield* makeHome("settings-removal");
        yield* seedSettings(home, [driver.connector(home, "text")]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* bootServer(home);
            const rpc = yield* (yield* connect(Effect.succeed(staticCredentials(server)))).rpc;
            yield* rpc["settings.update"]({ patch: { connectors: [] } }).pipe(Effect.orDie);
          }),
        );
        const server = yield* bootServer(home);
        const rpc = yield* (yield* connect(Effect.succeed(staticCredentials(server)))).rpc;
        expect(yield* rpc["connectors.list"]({}).pipe(Effect.orDie)).toEqual([]);
      }),
    ),
  );
};

forEachDriver("the settings pages", settings);
