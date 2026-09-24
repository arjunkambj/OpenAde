/**
 * An image on a Claude Code turn, through the whole server.
 *
 * The composer's upload is staged by the server as for any connector; the
 * Claude Code connector then sends the file's bytes as an image content block
 * ahead of the text, typed by its magic bytes, so the model sees the picture
 * without reading a file. The answer is the colour.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { assistantText, connect, isSettled, startTurn, staticCredentials } from "../e2e/harness";
import { claudeScenario } from "./harness";

/** The 2×2 red PNG the Command Code image recording was made with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

const ASK_COLOUR = "What colour is the image? Answer with one word.";

claudeScenario(
  "an image on a Claude Code turn",
  {
    scenario: "image",
    description:
      "A 2×2 red PNG staged through attachments.stage and sent with the turn as an image content block; the model names its colour.",
    prompts: [ASK_COLOUR],
  },
  "sends the staged image as a content block, and the model reads it",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));
      const open = yield* run.openThread(client);

      const staged = yield* (yield* client.rpc)
        ["attachments.stage"]({ threadId: open.threadId, name: "red.png", base64: RED_PNG_BASE64 })
        .pipe(Effect.orDie);
      expect(staged.mime).toBe("image/png");

      const started = yield* startTurn(client, open, {
        text: ASK_COLOUR,
        attachments: [{ path: staged.path, mime: staged.mime, name: staged.name }],
      });
      const done = yield* open.view.awaitValue(
        (view) => isSettled(view) && view.items.some((item) => item.kind === "assistant_message"),
        started,
      );
      expect(done.items.filter((item) => item.kind === "error")).toEqual([]);
      const sent = done.items.filter((item) => item.kind === "user_message");
      expect(sent[0]?.attachments?.[0]?.path).toBe(staged.path);
      // The model saw the picture itself: no tool call read the file.
      expect(done.items.some((item) => item.kind === "tool_call")).toBe(false);
      expect(assistantText(done).toLowerCase()).toContain("red");
    }),
);
