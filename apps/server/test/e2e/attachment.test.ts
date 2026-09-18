/**
 * Scenario (i): an image on a turn.
 *
 * Print mode has no image flag, so an attachment is not a parameter — it is a
 * file the server stages under its own attachments directory, a `--add-dir`
 * that puts the directory in the run's scope, and an absolute path named in
 * the prompt (decision w10-attachments). Three pieces that have to agree, and
 * the only way to know they do is to give a model a picture and ask it what it
 * sees.
 *
 * `fixtures/cmd/image/` is that run: a 2×2 red PNG staged exactly this way,
 * and the answer the real model gave when it read it.
 */

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  assistantText,
  autoApprove,
  bootServer,
  connect,
  forEachDriver,
  isSettled,
  makeHome,
  openThread,
  seedSettings,
  startTurn,
  staticCredentials,
  type Driver,
} from "./harness";

/**
 * A 2×2 solid PNG of `COLOURS.red`, the very bytes
 * `packages/testkit/scripts/record-assets.mjs` staged for
 * `fixtures/cmd/image/`. A hand-written stand-in is not good enough here: the
 * provider decodes the file and answers `400 invalid image data` for anything
 * that is not a real PNG, which is a failure of the fixture rather than of the
 * path under test.
 */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

const ASK_COLOUR = "What colour is the image? Answer with one word.";

const attachments = (driver: Driver) => {
  it.live("stages an image, sends it with the turn, and the model reads it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("attachment");
        yield* seedSettings(home, [driver.connector(home, "image")]);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const open = yield* openThread(client, home);
        yield* autoApprove(client, open);

        // The composer's own path: the bytes go up over the authenticated
        // socket, and what comes back is a reference with no bytes in it.
        const staged = yield* (yield* client.rpc)
          ["attachments.stage"]({
            threadId: open.threadId,
            name: "red.png",
            base64: RED_PNG_BASE64,
          })
          .pipe(Effect.orDie);
        expect(staged.mime).toBe("image/png");
        expect(staged.size).toBeGreaterThan(0);
        expect(staged.sha256.length).toBeGreaterThan(0);

        const started = yield* startTurn(client, open, {
          text: ASK_COLOUR,
          attachments: [{ path: staged.path, mime: staged.mime, name: staged.name }],
        });
        const done = yield* open.view.awaitValue(
          (view) =>
            isSettled(view) &&
            view.items.some((i) => i.kind === "assistant_message" || i.kind === "error"),
          started,
        );
        // A turn that died says so on the timeline now, so a failure here reads
        // as the reason rather than as a wait that never ended.
        const failed = done.items.filter((item) => item.kind === "error");
        expect(failed.map((item) => item.text ?? "")).toEqual([]);

        // The row the timeline draws a thumbnail from carries the reference,
        // not the bytes.
        const sent = done.items.filter((item) => item.kind === "user_message");
        expect(sent).toHaveLength(1);
        expect(sent[0]!.attachments ?? []).toHaveLength(1);
        expect(sent[0]!.attachments![0]!.path).toBe(staged.path);

        // And the bytes come back on demand, which is how the thumbnail is
        // drawn without a second public route or a second token.
        const bytes = yield* (yield* client.rpc)
          ["attachments.read"]({
            threadId: open.threadId,
            path: staged.path,
          })
          .pipe(Effect.orDie);
        expect(bytes.mime).toBe("image/png");
        expect(bytes.base64).toBe(RED_PNG_BASE64);

        // The model read the file: the whole point of staging it where the run
        // can reach it and naming the path in the prompt.
        expect(assistantText(done).toLowerCase()).toContain("red");
      }),
    ),
  );
};

forEachDriver("an image attachment", attachments);
