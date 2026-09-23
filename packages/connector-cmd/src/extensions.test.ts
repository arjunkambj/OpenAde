/**
 * Command Code's skills and MCP server extensions proven end to end: an add
 * lands in Command Code's own `mcp.json` carrying the `_openade` marker, a
 * hand-authored entry without the marker survives a round-trip untouched,
 * remove refuses unmanaged entries, skills are discovered from the user and
 * project `skills` roots, and a skill in the shared agents folder is linked
 * into the user root by symlink.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import type {
  ExtensionScope,
  McpServersExtension,
  SkillsExtension,
} from "@OpenAde/connector-sdk/extensions";
import { makeConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { McpServerConfig } from "@OpenAde/contracts/connectors";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CmdConnectorConfig } from "./configSchema";
import { makeCmdConnectorDefinition, type CmdConnectorOptions } from "./definition";

interface Fixture {
  /** Temp dir standing in for `~/.commandcode`. */
  readonly home: string;
  /** Temp dir standing in for `~/.agents/skills`. */
  readonly agents: string;
  /** Temp dir standing in for the project's workspace root. */
  readonly root: string;
  /** The user scope alone. */
  readonly user: ExtensionScope;
  /** The user scope plus the project at `root`. */
  readonly project: ExtensionScope;
  readonly mcp: McpServersExtension;
  readonly skills: Required<SkillsExtension>;
}

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "test" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "test" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/openade-cmd-extensions-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

/** The extensions an instance of the real definition carries. */
const extensionsOf = (options: CmdConnectorOptions, config: CmdConnectorConfig = {}) =>
  Effect.gen(function* () {
    const instance = yield* makeCmdConnectorDefinition(options).createInstance({
      instanceId: makeConnectorInstanceId(),
      config,
      services: yield* services,
    });
    const { skills, mcpServers } = instance.extensions ?? {};
    if (skills?.available === undefined || skills.link === undefined || mcpServers === undefined) {
      return yield* Effect.die("the cmd instance carries every extension");
    }
    return {
      mcp: mcpServers,
      skills: { list: skills.list, available: skills.available, link: skills.link },
    };
  });

/** Temp Command Code home, agents folder and workspace root. */
const fixture = Effect.gen(function* () {
  const home = mkdtempSync(nodePath.join(tmpdir(), "openade-cmd-home-"));
  const root = mkdtempSync(nodePath.join(tmpdir(), "openade-cmd-project-"));
  const agents = mkdtempSync(nodePath.join(tmpdir(), "openade-agents-skills-"));
  const extensions = yield* extensionsOf({ commandCodeHome: home, agentsSkillsRoot: agents });
  return {
    home,
    agents,
    root,
    user: { workspaceRoot: null },
    project: { workspaceRoot: root },
    ...extensions,
  } satisfies Fixture;
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

describe("the cmd extensions", () => {
  it.effect("add writes the user mcp.json with an ownership marker", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const list = yield* f.mcp.add(f.user, httpServer());
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

  it.effect("a hand-authored entry without the marker survives an add round-trip", () =>
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

        const list = yield* f.mcp.add(f.user, httpServer());
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

  it.effect("add refuses to overwrite an unmanaged entry of the same name", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        writeFileSync(
          userMcpPath(f.home),
          JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://hand" } } }),
        );
        const exit = yield* Effect.exit(f.mcp.add(f.user, httpServer()));
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
        const after = yield* f.mcp.remove(f.user, "user", "docs");
        expect(after.map((server) => server.name)).toEqual(["handwritten"]);
        expect(existsSync(userMcpPath(f.home))).toBe(true);
        expect(readDoc(userMcpPath(f.home)).mcpServers.handwritten).toBeDefined();

        const exit = yield* Effect.exit(f.mcp.remove(f.user, "user", "handwritten"));
        expect(exit._tag).toBe("Failure");
        expect(readDoc(userMcpPath(f.home)).mcpServers.handwritten).toBeDefined();
      }),
    ),
  );

  it.effect("project scope reads and writes <root>/.mcp.json", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.mcp.add(
          f.project,
          httpServer({ name: "local", scope: "project", transport: "stdio", command: "srv" }),
        );
        expect(readDoc(projectMcpPath(f.root)).mcpServers.local).toMatchObject({
          type: "stdio",
          command: "srv",
          _openade: { enabled: true },
        });
        // The project scope lists user + project; the user scope only the user file.
        const both = yield* f.mcp.list(f.project);
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
        expect(yield* f.mcp.list(f.user)).toEqual([]);

        const add = yield* Effect.exit(f.mcp.add(f.user, httpServer()));
        expect(add._tag).toBe("Failure");
        expect(readFileSync(userMcpPath(f.home), "utf8")).toBe(original);

        const remove = yield* Effect.exit(f.mcp.remove(f.user, "user", "handwritten"));
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
        const list = yield* f.mcp.add(f.user, httpServer());
        expect(list.map((server) => server.name)).toEqual(["docs"]);
      }),
    ),
  );

  it.effect("disabling takes the server out of the map the harness launches", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.mcp.add(f.user, httpServer());
        expect(readDoc(userMcpPath(f.home)).mcpServers.docs).toBeDefined();

        const disabled = yield* f.mcp.add(f.user, httpServer({ enabled: false }));
        expect(disabled[0]).toMatchObject({ name: "docs", enabled: false, managed: true });
        const parked = readDoc(userMcpPath(f.home));
        // The definition survives verbatim, but not where Command Code looks.
        expect(parked.mcpServers.docs).toBeUndefined();
        expect(parked._openadeDisabled).toMatchObject({
          docs: { type: "http", url: "https://example.com/mcp", _openade: { enabled: false } },
        });

        const reEnabled = yield* f.mcp.add(f.user, httpServer());
        expect(reEnabled[0]?.enabled).toBe(true);
        const live = readDoc(userMcpPath(f.home));
        expect(live.mcpServers.docs).toMatchObject({ type: "http", _openade: { enabled: true } });
        expect(live._openadeDisabled).toBeUndefined();
      }),
    ),
  );

  it.effect("a disabled server can be removed from the park", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.mcp.add(f.user, httpServer({ enabled: false }));
        const after = yield* f.mcp.remove(f.user, "user", "docs");
        expect(after).toEqual([]);
        expect(readDoc(userMcpPath(f.home))._openadeDisabled).toBeUndefined();
      }),
    ),
  );

  it.effect("entries the reader cannot make sense of survive an unrelated edit", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        mkdirSync(f.home, { recursive: true });
        writeFileSync(
          userMcpPath(f.home),
          `${JSON.stringify({
            mcpServers: { broken: null, odd: "not-an-object" },
            // Parked by hand, without our marker: ours to leave alone.
            _openadeDisabled: { handParked: { type: "stdio", command: "hand" } },
          })}\n`,
        );

        yield* f.mcp.add(f.user, httpServer());
        const afterAdd = readDoc(userMcpPath(f.home));
        expect(afterAdd.mcpServers.broken).toBeNull();
        expect(afterAdd.mcpServers.odd).toBe("not-an-object");
        expect(afterAdd._openadeDisabled).toEqual({
          handParked: { type: "stdio", command: "hand" },
        });

        yield* f.mcp.remove(f.user, "user", "docs");
        const afterRemove = readDoc(userMcpPath(f.home));
        expect(afterRemove.mcpServers.broken).toBeNull();
        expect(afterRemove.mcpServers.odd).toBe("not-an-object");
        // The park still holds a hand-written entry, so the key stays.
        expect(afterRemove._openadeDisabled).toEqual({
          handParked: { type: "stdio", command: "hand" },
        });
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
        writeFileSync(
          nodePath.join(f.home, "skills", "folded.md"),
          "---\ndescription: >-\n  first line\n  second line\nname: folded\n---\n",
        );
        mkdirSync(nodePath.join(f.root, ".commandcode", "skills", "review"), { recursive: true });
        writeFileSync(
          nodePath.join(f.root, ".commandcode", "skills", "review", "SKILL.md"),
          "---\nname: review\ndescription: project copy\n---\nbody\n",
        );

        const skills = yield* f.skills.list(f.project);
        const byName = new Map(skills.map((skill) => [skill.name, skill]));
        expect(byName.get("review")?.description).toBe("project copy");
        expect(byName.get("review")?.path).toContain(".commandcode");
        expect(byName.get("loose")?.description).toBe("loose user skill");
        expect(byName.get("folded")?.description).toBe("first line second line");
      }),
    ),
  );

  it.effect("an agents-folder skill is listed until linked, then loads from the user root", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        for (const name of ["lint", "already"]) {
          mkdirSync(nodePath.join(f.agents, name), { recursive: true });
          writeFileSync(
            nodePath.join(f.agents, name, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
          );
        }
        mkdirSync(nodePath.join(f.home, "skills"), { recursive: true });
        symlinkSync(nodePath.join(f.agents, "already"), nodePath.join(f.home, "skills", "already"));

        const before = yield* f.skills.available;
        expect(before.map((skill) => skill.entry)).toEqual(["lint"]);

        const after = yield* f.skills.link("lint");
        expect(after).toEqual([]);
        const link = nodePath.join(f.home, "skills", "lint");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(nodePath.isAbsolute(readlinkSync(link))).toBe(false);
        const skills = yield* f.skills.list(f.user);
        expect(skills.find((skill) => skill.name === "lint")?.description).toBe("lint skill");

        const again = yield* Effect.flip(f.skills.link("lint"));
        expect(again.code).toBe("not-found");
        const escape = yield* Effect.flip(f.skills.link("../lint"));
        expect(escape.code).toBe("not-found");
      }),
    ),
  );

  it.effect("an instance whose extraEnv sets HOME reads that home's config", () =>
    Effect.gen(function* () {
      const userHome = mkdtempSync(nodePath.join(tmpdir(), "openade-cmd-user-home-"));
      const { mcp, skills } = yield* extensionsOf({}, { extraEnv: { HOME: userHome } });
      yield* mcp.add({ workspaceRoot: null }, httpServer());
      // The CLI resolves `~/.commandcode` against the HOME it is given, so the
      // page edits that one rather than the server's.
      expect(
        readDoc(nodePath.join(userHome, ".commandcode", "mcp.json")).mcpServers.docs,
      ).toMatchObject({
        _openade: { enabled: true },
      });
      mkdirSync(nodePath.join(userHome, ".agents", "skills", "shared"), { recursive: true });
      writeFileSync(
        nodePath.join(userHome, ".agents", "skills", "shared", "SKILL.md"),
        "---\nname: shared\n---\n",
      );
      expect((yield* skills.available).map((skill) => skill.entry)).toEqual(["shared"]);
    }).pipe(Effect.scoped),
  );
});
