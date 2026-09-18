/**
 * The log's two halves of one rule: what may be written, and what a read does
 * with a row that should never have been.
 *
 * Payloads used to be written unvalidated and read back with a throwing
 * decode, so a single schema-violating row was a poison pill — the thread
 * stopped opening, and the checkpoint reactor's boot replay took the server's
 * whole layer build with it.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeEventId, makeThreadId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { persistenceLayer } from "../../test/layers";
import { EventStore, InvalidEvent, type PlannedEvent } from "./EventStore";

const threadId = makeThreadId();
const NOW = "2026-01-02T03:04:05.000Z";

const errorEvent = (message: string): PlannedEvent =>
  ({
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    occurredAt: NOW,
    actor: "system",
    type: "thread.error",
    payload: { message, fatal: true },
  }) as PlannedEvent;

describe("EventStore", () => {
  it.effect("refuses a planned event the orchestration union rejects", () =>
    Effect.gen(function* () {
      const store = yield* EventStore;

      // `thread.error.message` is a NonEmptyString, but the refined schema
      // types are not branded, so `""` type-checks all the way to the insert.
      const failure = yield* store.append("thread", threadId, [errorEvent("")]).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(InvalidEvent);
      expect((failure as InvalidEvent).eventType).toBe("thread.error");

      // The command that produced it fails; the log stays readable.
      expect(yield* store.loadStream("thread", threadId)).toHaveLength(0);
      expect(yield* store.append("thread", threadId, [errorEvent("the connector failed")]));
      expect(yield* store.loadStream("thread", threadId)).toHaveLength(1);
    }).pipe(Effect.provide(persistenceLayer())),
  );

  it.effect("answers a type query off the index instead of scanning the log", () =>
    Effect.gen(function* () {
      const store = yield* EventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.append("thread", threadId, [errorEvent("one"), errorEvent("two")]);
      yield* store.append("thread", threadId, [
        {
          eventId: makeEventId(),
          streamKind: "thread",
          streamId: threadId,
          occurredAt: NOW,
          actor: "user",
          type: "thread.renamed",
          payload: { title: "renamed" },
        } as PlannedEvent,
      ]);

      const renames = yield* store.threadEventsOfTypes(["thread.renamed"]);
      expect(renames.map((event) => event.type)).toEqual(["thread.renamed"]);
      expect(yield* store.threadEventsOfTypes([])).toEqual([]);

      // The point of the query: the checkpoint reactor runs it inside the layer
      // build, before the handshake the desktop supervisor is timing. A plan
      // that says SCAN would put the boot back under the whole log's weight.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence FROM events
        WHERE stream_kind = 'thread' AND type IN ('thread.renamed')
        ORDER BY sequence
      `;
      expect(plan.map((row) => row.detail).join(" ")).toContain("idx_events_type_sequence");
    }).pipe(Effect.provide(persistenceLayer())),
  );

  it.effect("skips an undecodable row instead of dying on it", () =>
    Effect.gen(function* () {
      const store = yield* EventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.append("thread", threadId, [errorEvent("first")]);

      // What an older build could write, and what a hand-edited database can
      // still hold. Every read path used to throw a *defect* on this row, which
      // no `Effect.catch` in the graph could stop.
      yield* sql`
        INSERT INTO events (
          event_id, stream_kind, stream_id, stream_version, type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor, payload_json
        ) VALUES (
          ${makeEventId()}, 'thread', ${threadId}, 2, 'thread.error',
          ${NOW}, NULL, NULL, NULL, 'system', ${JSON.stringify({ message: "", fatal: true })}
        )
      `;
      yield* store.append("thread", threadId, [errorEvent("third")]);

      const loaded = yield* store.loadStream("thread", threadId);
      expect(loaded.map((event) => (event.payload as { message: string }).message)).toEqual([
        "first",
        "third",
      ]);
      expect(yield* store.threadEventsAfter(0)).toHaveLength(2);
      expect(yield* store.allEvents).toHaveLength(2);
    }).pipe(Effect.provide(persistenceLayer())),
  );
});
