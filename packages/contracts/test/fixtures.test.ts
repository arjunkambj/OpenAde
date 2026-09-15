/**
 * Every wire schema, exercised against checked-in JSON.
 *
 * The fixtures are the contract made concrete: one file per RuntimeEvent
 * variant, per ItemKind, per Command and per OrchestrationEventType, plus a
 * full thread snapshot and a settings document. Each one is decoded and then
 * encoded again, and the result has to equal the bytes on disk — a schema
 * change that silently drops or renames a field fails here rather than in the
 * renderer.
 *
 * The coverage tests derive their lists from the schemas themselves, so adding
 * a variant without adding its fixture is a failing test, not a TODO.
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
  CommandType,
  OrchestrationEvent,
  OrchestrationEventType,
  ThreadDetailSnapshot,
} from "../src/orchestration";
import { ItemSnapshot, RuntimeEvent, RuntimeEventType } from "../src/runtime";
import { Settings } from "../src/settings";

const FIXTURES = NodePath.resolve(NodeURL.fileURLToPath(new URL("../fixtures", import.meta.url)));

/** Fixture names in one directory, without the `.json`, in sorted order. */
const namesIn = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(NodePath.join(FIXTURES, directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();

const read = (relativePath: string): unknown =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(FIXTURES, relativePath), "utf8")) as unknown;

/**
 * Decodes a fixture and encodes it back. Anything the schema does not carry
 * shows up as a difference against the file on disk.
 */
const roundTrip = <S extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>>(
  schema: S,
  relativePath: string,
): void => {
  const raw = read(relativePath);
  const decoded = Schema.decodeUnknownSync(schema)(raw);
  const encoded = Schema.encodeUnknownSync(schema)(decoded);
  expect(encoded, `${relativePath} does not survive decode → encode`).toStrictEqual(raw);
};

const families = [
  { directory: "runtime-events", schema: RuntimeEvent },
  { directory: "items", schema: ItemSnapshot },
  { directory: "commands", schema: Command },
  { directory: "orchestration-events", schema: OrchestrationEvent },
] as const;

describe("fixture round-trips", () => {
  for (const family of families) {
    it.effect(`${family.directory} decode and encode back to the same JSON`, () =>
      Effect.gen(function* () {
        const names = yield* Effect.sync(() => namesIn(family.directory));
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          yield* Effect.sync(() =>
            roundTrip(family.schema, NodePath.join(family.directory, `${name}.json`)),
          );
        }
      }),
    );
  }

  it.effect("the thread snapshot decodes and encodes back to the same JSON", () =>
    Effect.gen(function* () {
      yield* Effect.sync(() => roundTrip(ThreadDetailSnapshot, "thread-detail-snapshot.json"));
    }),
  );

  it.effect("the settings document decodes and encodes back to the same JSON", () =>
    Effect.gen(function* () {
      yield* Effect.sync(() => roundTrip(Settings, "settings.json"));
    }),
  );
});

describe("fixture coverage", () => {
  it.effect("every RuntimeEvent variant has a fixture, and every fixture a variant", () =>
    Effect.gen(function* () {
      const names = yield* Effect.sync(() => namesIn("runtime-events"));
      expect(names).toEqual([...RuntimeEventType.literals].sort());
    }),
  );

  it.effect("every ItemKind has a fixture, and every fixture an ItemKind", () =>
    Effect.gen(function* () {
      const names = yield* Effect.sync(() => namesIn("items"));
      expect(names).toEqual([...ItemKind.literals].sort());
    }),
  );

  it.effect("every Command has a fixture, and every fixture a Command", () =>
    Effect.gen(function* () {
      const names = yield* Effect.sync(() => namesIn("commands"));
      expect(names).toEqual([...CommandType.literals].sort());
    }),
  );

  it.effect("every OrchestrationEventType has a fixture, and every fixture a type", () =>
    Effect.gen(function* () {
      const names = yield* Effect.sync(() => namesIn("orchestration-events"));
      expect(names).toEqual([...OrchestrationEventType.literals].sort());
    }),
  );

  it.effect("each fixture's file name matches the type inside it", () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.sync(() => [
        ...namesIn("runtime-events").map((name) => [`runtime-events/${name}.json`, name] as const),
        ...namesIn("commands").map((name) => [`commands/${name}.json`, name] as const),
        ...namesIn("orchestration-events").map(
          (name) => [`orchestration-events/${name}.json`, name] as const,
        ),
      ]);
      for (const [path, name] of tagged) {
        const value = read(path) as { readonly type: string };
        expect(value.type, `${path} is named for a different type`).toBe(name);
      }
      for (const name of namesIn("items")) {
        const value = read(`items/${name}.json`) as { readonly kind: string };
        expect(value.kind, `items/${name}.json is named for a different kind`).toBe(name);
      }
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
