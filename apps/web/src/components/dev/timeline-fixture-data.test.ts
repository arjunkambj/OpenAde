import { ItemKind } from "@OpenAde/contracts/enums";
import { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { isUuidV7, uuidV7Millis } from "@OpenAde/shared/ids";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { buildRichTimelineSnapshot } from "@/components/dev/timeline-fixture-data";
import { STREAM_TEXT, streamedText } from "@/components/dev/timeline-fixture-text";
import { FIXTURE_IMAGES } from "@/lib/fixture-images";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

const build = (options: Parameters<typeof buildRichTimelineSnapshot>[0] = {}) =>
  buildRichTimelineSnapshot({ now: NOW, ...options });

const userMessages = (snapshot: ThreadDetailSnapshot) =>
  snapshot.items.filter((item) => item.kind === "user_message");

describe("buildRichTimelineSnapshot", () => {
  it("decodes as a thread detail snapshot", () => {
    const snapshot = build();
    expect(Schema.decodeUnknownSync(ThreadDetailSnapshot)(snapshot)).toEqual(snapshot);
  });

  it("holds every item kind", () => {
    const kinds = new Set(build().items.map((item) => item.kind));
    expect([...ItemKind.literals].filter((kind) => !kinds.has(kind))).toEqual([]);
  });

  it("mints unique, ascending UUIDv7 item ids", () => {
    const ids = build({ copies: 3 }).items.map((item) => item.itemId);
    expect(ids.every(isUuidV7)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    const millis = ids.map((id) => uuidV7Millis(id) ?? 0);
    expect(millis.every((value, index) => index === 0 || value > millis[index - 1]!)).toBe(true);
  });

  it("is the same thread for the same clock", () => {
    expect(build()).toEqual(build());
  });

  it("gives every settled turn but the first a checkpoint", () => {
    const snapshot = build();
    const turns = [...new Set(snapshot.items.map((item) => item.turnId))];
    const settled = turns.filter((turnId) => turnId !== snapshot.currentTurnId);
    const checkpointed = snapshot.checkpoints.map((checkpoint) => checkpoint.turnId);
    expect(checkpointed.every((turnId) => settled.includes(turnId!))).toBe(true);
    expect(checkpointed).not.toContain(turns[0]);
    expect(checkpointed).toEqual(settled.slice(1));
    expect(checkpointed).not.toContain(snapshot.currentTurnId);
  });

  it("repeats the settled turns per copy, with one checkpointless first turn", () => {
    const one = build();
    const three = build({ copies: 3 });
    expect(userMessages(three).length).toBe(1 + (userMessages(one).length - 1) * 3);
    expect(three.checkpoints.length).toBe(one.checkpoints.length * 3 + 2);
  });

  it("ends on a turn that started a little before now", () => {
    const snapshot = build();
    expect(snapshot.status).toBe("running");
    expect(snapshot.currentTurnId).not.toBeNull();
    const started = uuidV7Millis(snapshot.currentTurnId!)!;
    expect(NOW - started).toBeGreaterThan(30_000);
    expect(NOW - started).toBeLessThan(60_000);
    expect(snapshot.items.at(-1)?.turnId).toBe(snapshot.currentTurnId);
    expect(snapshot.items.at(-1)?.status).toBe("in_progress");
  });

  it("settles everything when asked for no running turn", () => {
    const snapshot = build({ running: false });
    expect(snapshot.status).toBe("idle");
    expect(snapshot.currentTurnId).toBeNull();
    expect(snapshot.items.some((item) => item.status === "in_progress")).toBe(false);
  });

  it("carries a long message with attachments the fixture client can read", () => {
    const long = userMessages(build()).find((item) => (item.attachments?.length ?? 0) > 0);
    expect(long?.text?.length).toBeGreaterThan(600);
    expect(long?.text?.split("\n").length).toBeGreaterThan(10);
    expect(long?.attachments).toHaveLength(2);
    expect(long?.attachments?.every((attachment) => FIXTURE_IMAGES.has(attachment.path))).toBe(
      true,
    );
    expect(long?.references?.map((reference) => reference.kind)).toEqual(["skill", "plugin"]);
  });

  it("steers a second message into a running turn", () => {
    const turns = userMessages(build()).map((item) => item.turnId);
    expect(new Set(turns).size).toBeLessThan(turns.length);
  });

  it("anchors every decision on an item, with every outcome kind", () => {
    const snapshot = build();
    const ids = new Set(snapshot.items.map((item) => item.itemId));
    const decisions = snapshot.decisions ?? [];
    expect(decisions.every((decision) => ids.has(decision.afterItemId!))).toBe(true);
    expect(decisions.map((decision) => decision.outcome).sort()).toEqual([
      "accept",
      "allow-once",
      "answered",
      "deny",
    ]);
  });

  it("has failures, a nested task and every todo state", () => {
    const items = build().items;
    expect(items.some((item) => item.command?.exitCode === 1)).toBe(true);
    const task = items.find((item) => item.kind === "task");
    expect(items.filter((item) => item.parentItemId === task?.itemId).length).toBeGreaterThan(0);
    const states = new Set(items.flatMap((item) => item.todos ?? []).map((todo) => todo.status));
    expect(states).toEqual(new Set(["pending", "in_progress", "completed"]));
    const changes = new Set(items.flatMap((item) => item.fileChange?.kind ?? []));
    expect(changes).toEqual(new Set(["create", "edit", "delete"]));
  });
});

describe("streamedText", () => {
  it("grows by a few words per tick until the whole text is out", () => {
    let current = "";
    let ticks = 0;
    while (current !== STREAM_TEXT) {
      const next = streamedText(current);
      expect(next.startsWith(current)).toBe(true);
      expect(next.length).toBeGreaterThan(current.length);
      current = next;
      ticks += 1;
    }
    expect(ticks).toBeGreaterThan(10);
    expect(streamedText(STREAM_TEXT)).toBe(STREAM_TEXT);
  });
});
