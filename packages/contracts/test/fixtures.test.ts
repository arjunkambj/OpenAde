/**
 * Every wire schema, exercised against checked-in JSON.
 *
 * The fixtures are the contract made concrete: one file per RuntimeEvent
 * variant, per ItemKind, per Command and per OrchestrationEventType, one per
 * stream frame the renderer can receive, and one per read model and RPC result
 * the client decodes. Each one is decoded and then encoded again, and the
 * result has to equal the bytes on disk — a schema change that silently drops
 * or renames a field fails here rather than in the renderer.
 *
 * The coverage tests derive their lists from the schemas themselves, so adding
 * a variant without adding its fixture is a failing test, not a TODO, and no
 * fixture file may sit in the tree without a case that reads it.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ItemKind } from "../src/enums";
import {
  Command,
  CommandReceipt,
  CommandType,
  OrchestrationEvent,
  OrchestrationEventType,
  ProjectSummary,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "../src/orchestration";
import {
  ConnectorDescriptor,
  ConnectorProbe,
  ConnectorSummary,
  McpServerConfig,
  ModelOption,
  SkillSummary,
} from "../src/connectors";
import {
  AttachmentBytes,
  BrowserHumanInput,
  BrowserState,
  FileContent,
  FileSearchResult,
  FsBrowseError,
  FsListing,
  GitDiff,
  GitStatus,
  ServerHello,
  StagedAttachment,
} from "../src/rpc";
import { ItemSnapshot, RuntimeEvent, RuntimeEventType } from "../src/runtime";
import { Settings } from "../src/settings";

const FIXTURES = NodePath.resolve(NodeURL.fileURLToPath(new URL("../fixtures", import.meta.url)));

/** Fixture names in one directory, without the `.json`, in sorted order. */
const namesIn = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(NodePath.join(FIXTURES, directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();

/** Every fixture in the tree, as a path relative to `fixtures/`. */
const everyFixture = (): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const visit = (relative: string): void => {
    for (const entry of NodeFS.readdirSync(NodePath.join(FIXTURES, relative), {
      withFileTypes: true,
    })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.name.endsWith(".json")) {
        found.push(child);
      }
    }
  };
  visit("");
  return found.sort();
};

const read = (relativePath: string): unknown =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(FIXTURES, relativePath), "utf8")) as unknown;

type FixtureSchema = Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>;

/**
 * Decodes a fixture and encodes it back. Anything the schema does not carry
 * shows up as a difference against the file on disk.
 */
const roundTrip = (schema: FixtureSchema, relativePath: string): void => {
  const raw = read(relativePath);
  const decoded = Schema.decodeUnknownSync(schema)(raw);
  const encoded = Schema.encodeUnknownSync(schema)(decoded);
  expect(encoded, `${relativePath} does not survive decode → encode`).toStrictEqual(raw);
};

/** The literal each member of a tagged union carries in `field`. */
const tagsOf = (
  members: ReadonlyArray<{ readonly fields: { readonly [key: string]: unknown } }>,
  field: string,
): ReadonlyArray<string> =>
  members.map((member) => {
    const literal = (member.fields[field] as { readonly literal?: unknown } | undefined)?.literal;
    if (typeof literal !== "string") {
      throw new Error(`a union member has no literal \`${field}\` to name its fixture for`);
    }
    return literal;
  });

/**
 * A union with one fixture per variant. `tag` is the field whose literal the
 * file is named for, so `snapshot.json` and `{ "kind": "snapshot" }` can never
 * drift apart.
 */
interface Family {
  readonly directory: string;
  readonly schema: FixtureSchema;
  readonly tag: string;
  readonly variants: ReadonlyArray<string>;
}

const families: ReadonlyArray<Family> = [
  {
    directory: "runtime-events",
    schema: RuntimeEvent,
    tag: "type",
    variants: RuntimeEventType.literals,
  },
  { directory: "items", schema: ItemSnapshot, tag: "kind", variants: ItemKind.literals },
  { directory: "commands", schema: Command, tag: "type", variants: CommandType.literals },
  {
    directory: "orchestration-events",
    schema: OrchestrationEvent,
    tag: "type",
    variants: OrchestrationEventType.literals,
  },
  {
    directory: "read-models/thread-stream-item",
    schema: ThreadStreamItem,
    tag: "kind",
    variants: tagsOf(ThreadStreamItem.members, "kind"),
  },
  {
    directory: "read-models/thread-list-stream-item",
    schema: ThreadListStreamItem,
    tag: "kind",
    variants: tagsOf(ThreadListStreamItem.members, "kind"),
  },
  {
    directory: "rpc/browser-human-input",
    schema: BrowserHumanInput,
    tag: "kind",
    variants: tagsOf(BrowserHumanInput.members, "kind"),
  },
];

/** A schema with a single fixture: a read model, an RPC result, a document. */
const singles: ReadonlyArray<{ readonly path: string; readonly schema: FixtureSchema }> = [
  { path: "thread-detail-snapshot.json", schema: ThreadDetailSnapshot },
  // The same thread with a checkpoint restore in flight: `restoring` is what a
  // client reads to keep the spinner up and the Restore button disabled across
  // a reload, so the populated shape needs its own round-trip.
  { path: "thread-detail-snapshot.restoring.json", schema: ThreadDetailSnapshot },
  { path: "settings.json", schema: Settings },
  { path: "read-models/project-summary.json", schema: ProjectSummary },
  { path: "read-models/thread-summary.json", schema: ThreadSummary },
  { path: "read-models/command-receipt.accepted.json", schema: CommandReceipt },
  { path: "read-models/command-receipt.rejected.json", schema: CommandReceipt },
  { path: "rpc/server-hello.json", schema: ServerHello },
  { path: "rpc/model-option.json", schema: ModelOption },
  { path: "rpc/connector-probe.json", schema: ConnectorProbe },
  { path: "rpc/connector-probe.probing.json", schema: ConnectorProbe },
  { path: "rpc/connector-summary.json", schema: ConnectorSummary },
  { path: "rpc/connector-descriptor.json", schema: ConnectorDescriptor },
  { path: "rpc/file-search-result.json", schema: FileSearchResult },
  { path: "rpc/file-content.json", schema: FileContent },
  { path: "rpc/fs-listing.json", schema: FsListing },
  { path: "rpc/fs-listing.root.json", schema: FsListing },
  { path: "rpc/fs-browse-error.json", schema: FsBrowseError },
  { path: "rpc/staged-attachment.json", schema: StagedAttachment },
  { path: "rpc/attachment-bytes.json", schema: AttachmentBytes },
  { path: "rpc/git-status.json", schema: GitStatus },
  { path: "rpc/git-status.not-a-repository.json", schema: GitStatus },
  { path: "rpc/git-diff.json", schema: GitDiff },
  { path: "rpc/git-diff.not-a-repository.json", schema: GitDiff },
  { path: "rpc/browser-state.json", schema: BrowserState },
  { path: "rpc/mcp-server-config.json", schema: McpServerConfig },
  { path: "rpc/skill-summary.json", schema: SkillSummary },
];

describe("fixture round-trips", () => {
  for (const family of families) {
    it.effect(`${family.directory} decode and encode back to the same JSON`, () =>
      Effect.gen(function* () {
        const names = yield* Effect.sync(() => namesIn(family.directory));
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          yield* Effect.sync(() => roundTrip(family.schema, `${family.directory}/${name}.json`));
        }
      }),
    );
  }

  for (const single of singles) {
    it.effect(`${single.path} decodes and encodes back to the same JSON`, () =>
      Effect.gen(function* () {
        yield* Effect.sync(() => roundTrip(single.schema, single.path));
      }),
    );
  }
});

describe("fixture coverage", () => {
  for (const family of families) {
    it.effect(`every ${family.directory} variant has a fixture, and every fixture a variant`, () =>
      Effect.gen(function* () {
        const names = yield* Effect.sync(() => namesIn(family.directory));
        expect(names).toEqual([...family.variants].sort());
      }),
    );
  }

  it.effect("every fixture in the tree is read by a case", () =>
    Effect.gen(function* () {
      const covered = yield* Effect.sync(
        () =>
          new Set([
            ...singles.map((single) => single.path),
            ...families.flatMap((family) =>
              namesIn(family.directory).map((name) => `${family.directory}/${name}.json`),
            ),
          ]),
      );
      const orphans = everyFixture().filter((path) => !covered.has(path));
      expect(orphans, "fixtures nothing round-trips").toEqual([]);
    }),
  );

  it.effect("each fixture's file name matches the tag inside it", () =>
    Effect.gen(function* () {
      const mismatches = yield* Effect.sync(() =>
        families.flatMap((family) =>
          namesIn(family.directory).flatMap((name) => {
            const path = `${family.directory}/${name}.json`;
            const value = read(path) as Record<string, unknown>;
            return value[family.tag] === name ? [] : [path];
          }),
        ),
      );
      expect(mismatches, "fixtures named for a different variant").toEqual([]);
    }),
  );
});

describe("the thread snapshot fixture", () => {
  it.effect("carries 20 items covering every ItemKind", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(read("thread-detail-snapshot.json")),
      );
      expect(snapshot.items).toHaveLength(20);
      const covered = new Set(snapshot.items.map((snapshotItem) => snapshotItem.kind));
      expect([...covered].sort()).toEqual([...ItemKind.literals].sort());
    }),
  );

  it.effect("reports a restore in flight, and the absence of one", () =>
    Effect.gen(function* () {
      const idle = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(read("thread-detail-snapshot.json")),
      );
      expect(idle.restoring ?? null).toBeNull();
      const restoring = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(
          read("thread-detail-snapshot.restoring.json"),
        ),
      );
      // The checkpoint it names is one the thread actually holds, which is what
      // the Changes pane needs to label the row it is restoring to.
      expect(restoring.restoring?.checkpointId).toBe(restoring.checkpoints[0]?.checkpointId);
    }),
  );

  it.effect("decodes a snapshot written before `restoring` existed", () =>
    Effect.gen(function* () {
      const { restoring: _restoring, ...older } = yield* Effect.sync(
        () => read("thread-detail-snapshot.json") as Record<string, unknown>,
      );
      const decoded = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(older),
      );
      expect(decoded.restoring).toBeUndefined();
    }),
  );

  it.effect("decodes a snapshot written before `decisions` existed", () =>
    Effect.gen(function* () {
      const { decisions: _decisions, ...older } = yield* Effect.sync(
        () => read("thread-detail-snapshot.json") as Record<string, unknown>,
      );
      const decoded = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(older),
      );
      expect(decoded.decisions).toBeUndefined();
    }),
  );

  it.effect("places every recorded decision after an item the snapshot holds", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(read("thread-detail-snapshot.json")),
      );
      const ids = new Set(snapshot.items.map((snapshotItem) => snapshotItem.itemId));
      expect(snapshot.decisions?.map((decision) => decision.kind).sort()).toEqual([
        "approval",
        "plan",
        "question",
      ]);
      for (const decision of snapshot.decisions ?? []) {
        expect(decision.afterItemId === undefined || ids.has(decision.afterItemId)).toBe(true);
      }
    }),
  );

  it.effect("gives every item a distinct id, the way a projection would", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ThreadDetailSnapshot)(read("thread-detail-snapshot.json")),
      );
      const ids = snapshot.items.map((snapshotItem) => snapshotItem.itemId);
      expect(new Set(ids).size).toBe(ids.length);
    }),
  );
});
