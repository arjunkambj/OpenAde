/**
 * A deleted thread takes its attachments with it.
 *
 * Only `thread.deleted` — an archived thread can be reopened and its timeline
 * still asks for its thumbnails, so archiving must not empty the directory.
 *
 * The subscription is opened in the building fiber and only the consume loop is
 * forked, for the reason the browser teardown reactor records: a forked fiber
 * does not start until the builder yields, and the engine's PubSub drops what
 * it publishes while nobody is listening — a thread deleted in that window
 * would keep its files for good.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngine } from "../orchestration/Engine";
import { AttachmentStore } from "./AttachmentStore";

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
      Effect.catch((error) => Effect.logWarning("attachment reactor ended", error)),
      Effect.forkScoped,
    );
  }),
);
