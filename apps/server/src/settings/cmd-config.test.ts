/**
 * The W9 done-when proof for `CmdConfig`: an upsert lands in Command Code's
 * own `mcp.json` carrying the `_openade` marker, a hand-authored entry without
 * the marker survives a round-trip untouched, remove refuses unmanaged entries,
 * and skills are discovered from the user and project `skills` roots.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeProjectId, type ProjectId } from "@OpenAde/contracts/ids";
import type { McpServerConfig } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { CmdConfig } from "../rpc/services";
import { layer as cmdConfigLayer } from "./CmdConfig";

interface Fixture {
  /** Temp dir standing in for `~/.commandcode`. */
  readonly home: string;
  /** Temp dir standing in for the project's workspace root. */
  readonly root: string;
  readonly projectId: ProjectId;
  readonly service: CmdConfig["Service"];
}

/** A temp Command Code home + a project row, over real sqlite read models. */
const fixture = Effect.gen(function* () {
  const home = mkdtempSync(nodePath.join(tmpdir(), "openade-cmd-home-"));
  const root = mkdtempSync(nodePath.join(tmpdir(), "openade-cmd-project-"));
  const sqliteContext = yield* Layer.build(sqliteTestLayer());
  const sqlite = Layer.succeedContext(sqliteContext);
  yield* runMigrations.pipe(Effect.provide(sqlite));
  const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
  const readModels = Context.get(rmContext, ReadModelStore);
  const projectId = makeProjectId();
  const now = new Date().toISOString();
  yield* readModels.putProject({
    projectId,
    name: "test",
    workspaceRoot: root,
    createdAt: now,
    updatedAt: now,
    removed: false,
  });
  const ctx = yield* Layer.build(
    cmdConfigLayer({ commandCodeHome: home }).pipe(Layer.provide(Layer.succeedContext(rmContext))),
  );
  return { home, root, projectId, service: Context.get(ctx, CmdConfig) } satisfies Fixture;
});

const withFixture = <A, E>(run: (fixture: Fixture) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(fixture, run));

const userMcpPath = (home: string) => nodePath.join(home, "mcp.json");
const projectMcpPath = (root: string) => nodePath.join(root, ".mcp.json");

const readDoc = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
    mcpServers: Record<string, Record<string, unknown>>;
  };

const httpServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "docs",
  scope: "user",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  ...over,
});

describe("CmdConfig", () => {
  it.effect("upsert writes the user mcp.json with an ownership marker", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const list = yield* f.service.mcpUpsert(undefined, httpServer());
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ name: "docs", scope: "user", transport: "http" });
        const onDisk = readDoc(userMcpPath(f.home));
        expect(onDisk.mcpServers.docs).toMatchObject({
          type: "http",
          url: "https://example.com/mcp",
          _openade: { enabled: true },
        });
      }),
    ),
  );

  it.effect("a hand-authored entry without the marker survives an upsert round-trip", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        mkdirSync(f.home, { recursive: true });
        writeFileSync(
          userMcpPath(f.home),
          `${JSON.stringify({
            mcpServers: {
              handwritten: { type: "stdio", command: "hand", args: ["--by", "hand"] },
            },
            otherTopLevelKey: { untouched: true },
          })}\n`,
        );

        const list = yield* f.service.mcpUpsert(undefined, httpServer());
        expect(list.map((server) => server.name).sort()).toEqual(["docs", "handwritten"]);

        const onDisk = readDoc(userMcpPath(f.home));
        // The managed entry gained the marker; the hand edit is byte-identical.
        expect(onDisk.mcpServers.docs?._openade).toEqual({ enabled: true });
        expect(onDisk.mcpServers.handwritten).toEqual({
          type: "stdio",
          command: "hand",
          args: ["--by", "hand"],
        });
        expect(onDisk.otherTopLevelKey).toEqual({ untouched: true });
      }),
    ),
  );

  it.effect("upsert refuses to overwrite an unmanaged entry of the same name", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        writeFileSync(
          userMcpPath(f.home),
          JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://hand" } } }),
        );
        const exit = yield* Effect.exit(f.service.mcpUpsert(undefined, httpServer()));
        expect(exit._tag).toBe("Failure");
        const onDisk = readDoc(userMcpPath(f.home));
        expect(onDisk.mcpServers.docs).toEqual({ type: "http", url: "https://hand" });
      }),
    ),
  );

  it.effect("remove deletes managed entries and refuses unmanaged ones", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        writeFileSync(
          userMcpPath(f.home),
          JSON.stringify({
            mcpServers: {
              docs: { type: "http", url: "https://example.com/mcp", _openade: { enabled: true } },
              handwritten: { type: "stdio", command: "hand" },
            },
          }),
        );
        const after = yield* f.service.mcpRemove(undefined, "user", "docs");
        expect(after.map((server) => server.name)).toEqual(["handwritten"]);
        expect(existsSync(userMcpPath(f.home))).toBe(true);
        expect(readDoc(userMcpPath(f.home)).mcpServers.handwritten).toBeDefined();

        const exit = yield* Effect.exit(f.service.mcpRemove(undefined, "user", "handwritten"));
        expect(exit._tag).toBe("Failure");
        expect(readDoc(userMcpPath(f.home)).mcpServers.handwritten).toBeDefined();
      }),
    ),
  );

  it.effect("project scope reads and writes <root>/.mcp.json", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.service.mcpUpsert(
          f.projectId,
          httpServer({ name: "local", scope: "project", transport: "stdio", command: "srv" }),
        );
        expect(readDoc(projectMcpPath(f.root)).mcpServers.local).toMatchObject({
          type: "stdio",
          command: "srv",
          _openade: { enabled: true },
        });
        // projectId lists user + project; without it, only the user file.
        const both = yield* f.service.mcpList(f.projectId);
        expect(both.map((server) => `${server.scope}:${server.name}`).sort()).toEqual([
          "project:local",
        ]);
      }),
    ),
  );

  it.effect("an unparseable mcp.json is listed as empty and never rewritten", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        // A trailing comma: valid JSON5-ish hand editing, invalid JSON.
        const original = `{\n  "mcpServers": {\n    "handwritten": { "type": "stdio", "command": "hand" },\n  }\n}\n`;
        mkdirSync(f.home, { recursive: true });
        writeFileSync(userMcpPath(f.home), original);

        // Listing degrades to "no servers" rather than failing the whole page.
        expect(yield* f.service.mcpList()).toEqual([]);

        const upsert = yield* Effect.exit(f.service.mcpUpsert(undefined, httpServer()));
        expect(upsert._tag).toBe("Failure");
        expect(readFileSync(userMcpPath(f.home), "utf8")).toBe(original);

        const remove = yield* Effect.exit(f.service.mcpRemove(undefined, "user", "handwritten"));
        expect(remove._tag).toBe("Failure");
        expect(readFileSync(userMcpPath(f.home), "utf8")).toBe(original);
      }),
    ),
  );

  it.effect("an empty mcp.json is treated as creatable, not as unreadable", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        mkdirSync(f.home, { recursive: true });
        writeFileSync(userMcpPath(f.home), "");
        const list = yield* f.service.mcpUpsert(undefined, httpServer());
        expect(list.map((server) => server.name)).toEqual(["docs"]);
      }),
    ),
  );

  it.effect("disabled servers round-trip through the marker", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.service.mcpUpsert(undefined, httpServer({ enabled: false }));
        const list = yield* f.service.mcpList();
        expect(list[0]?.enabled).toBe(false);
      }),
    ),
  );

  it.effect("skills come from user and project roots, project winning name collisions", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        mkdirSync(nodePath.join(f.home, "skills", "review"), { recursive: true });
        writeFileSync(
          nodePath.join(f.home, "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: user copy\n---\nbody\n",
        );
        writeFileSync(
          nodePath.join(f.home, "skills", "loose.md"),
          "---\ndescription: loose user skill\n---\n",
        );
        mkdirSync(nodePath.join(f.root, ".commandcode", "skills", "review"), { recursive: true });
        writeFileSync(
          nodePath.join(f.root, ".commandcode", "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: project copy\n---\nbody\n",
        );

        const skills = yield* f.service.skillsList(f.projectId);
        const byName = new Map(skills.map((skill) => [skill.name, skill]));
        expect(byName.get("review")?.description).toBe("project copy");
        expect(byName.get("review")?.path).toContain(".commandcode");
        expect(byName.get("loose")?.description).toBe("loose user skill");
      }),
    ),
  );
});
