/**
 * A deleted thread takes its attachments with it — and a boot takes the ones
 * no thread ever referenced.
 *
 * Only `thread.deleted` purges: an archived thread can be reopened and its
 * timeline still asks for its thumbnails, so archiving must not empty the
 * directory.
 *
 * The composer stages a file *before* it dispatches the turn, so a paste that
 * never became a message — a failed dispatch, a cleared draft, a closed window,
 * a server that died mid-send — was referenced by nothing and kept for the life
 * of the thread. Nothing in the product ever listed or removed those. The boot
 * sweep is where they go: it can only run when no composer of this process has
 * an upload in flight, and the grace window covers the previous process's.
 *
 * The subscription is opened in the building fiber and only the consume loop is
 * forked, for the reason the browser teardown reactor records: a forked fiber
 * does not start until the builder yields, and the engine's PubSub drops what
 * it publishes while nobody is listening — a thread deleted in that window
 * would keep its files for good.
 */

import * as NodePath from "node:path";

import type { ThreadId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngine } from "../orchestration/Engine";
import type { ThreadDoc } from "../orchestration/state";
import { AttachmentStore } from "./AttachmentStore";

/**
 * How recent a file has to be for the sweep to leave it alone. An hour is far
 * more than a paste needs and far less than "for ever": the file it protects is
 * one the previous process staged just before it went away, whose turn the user
 * may still send when they reopen the thread.
 */
const GRACE_MILLIS = 60 * 60 * 1000;

/** Every attachment path the thread document still points at. */
const referencedPaths = (doc: ThreadDoc): ReadonlySet<string> => {
  const paths = new Set<string>();
  const add = (attachments: ReadonlyArray<{ readonly path: string }> | undefined): void => {
    for (const attachment of attachments ?? []) {
      paths.add(NodePath.resolve(attachment.path));
    }
  };
  for (const item of doc.items) {
    add(item.attachments);
  }
  for (const message of doc.queue) {
    add(message.attachments);
  }
  add(doc.currentTurn?.input.attachments);
  return paths;
};

export const AttachmentReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const attachments = yield* AttachmentStore;

    const mailbox = yield* engine.subscribeEvents;
    yield* Stream.runForEach(Stream.fromSubscription(mailbox), (event) =>
      event.streamKind === "thread" && event.type === "thread.deleted"
        ? attachments.purge(event.streamId as ThreadId)
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("attachment reactor ended", cause)),
      Effect.forkScoped,
    );

    yield* Effect.gen(function* () {
      let removed = 0;
      for (const doc of yield* engine.threadDocs) {
        if (doc.deleted) {
          continue;
        }
        removed += yield* attachments.sweep(doc.threadId, referencedPaths(doc), GRACE_MILLIS);
      }
      if (removed > 0) {
        yield* Effect.logInfo(`attachments: removed ${removed} file(s) no turn ever referenced`);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("attachment sweep failed", cause)),
      Effect.forkScoped,
    );
  }),
);
