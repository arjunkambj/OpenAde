/**
 * The whole attachment path, against a real spawned process.
 *
 * `attachments.stage` writes a real PNG, the turn carries the reference, the
 * session copies nothing (the file is already under `attachmentsDir`), passes
 * the directory as `--add-dir` and names the absolute path in the prompt — and
 * testkit's standalone `fake-cmd.mjs` really opens the file and reports its
 * media type and byte count back. Everything but the model.
 *
 * Nothing touches the real `~/.commandcode` or `~/.openade`: both are
 * redirected into a temp directory for the file.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { makeCmdSession } from "@OpenAde/connector-cmd/session";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { AttachmentStore } from "./AttachmentStore";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** testkit's standalone fake, resolved from the workspace rather than copied. */
const fakeBinary = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../../../packages/testkit/bin/fake-cmd.mjs",
);

interface Fixture {
  readonly home: string;
  readonly workspace: string;
  readonly attachmentsDir: string;
  readonly store: AttachmentStore["Service"];
}

const fixture = (): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "attachment-turn-"))),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const home = NodePath.join(root, "home");
    const workspace = NodePath.join(root, "workspace");
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(home, { recursive: true });
      NodeFS.mkdirSync(workspace, { recursive: true });
    });
    const attachmentsDir = NodePath.join(root, "attachments");
    const context = yield* Layer.build(AttachmentStore.layerAt(attachmentsDir));
    return { home, workspace, attachmentsDir, store: Context.get(context, AttachmentStore) };
  });

const servicesFor = (attachmentsDir: string): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.succeed<ConnectorServices>({
      mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
      hookEndpoint: () =>
        Effect.succeed({ url: "http://127.0.0.1:9/hooks/pretooluse", bearer: "t" }),
      permissions: { decide: () => Effect.succeed("allow" as const) },
      attachmentsDir,
      logger: { log: () => Effect.void },
      clock,
    }),
  );

const openadeHomeAt = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.OPENADE_HOME;
      process.env.OPENADE_HOME = path;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.OPENADE_HOME;
        } else {
          process.env.OPENADE_HOME = previous;
        }
      }),
  );

const runTurn = (threadId: ThreadId, attachmentPath: string, f: Fixture) =>
  Effect.gen(function* () {
    const handle = yield* makeCmdSession({
      instanceId: makeConnectorInstanceId(),
      threadId,
      workspaceRoot: f.workspace,
      binaryPath: fakeBinary,
      extraEnv: { HOME: f.home },
      home: f.home,
      services: yield* servicesFor(f.attachmentsDir),
      settings: {
        model: "fake/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    const collector = yield* makeStreamCollector(handle.events);
    yield* handle.send({
      text: "what is in this picture?",
      attachments: [{ path: attachmentPath, mime: "image/png", name: "shot.png", size: 70 }],
      mentions: [],
    });
    yield* collector.awaitItem((event) => event.type === "turn.completed");
    return yield* collector.collected;
  });

describe("an attachment reaching the harness", () => {
  it.live("is really opened by the binary, with its type and size reported back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* openadeHomeAt(NodePath.join(f.home, "openade"));
        const threadId = makeThreadId();
        const staged = yield* f.store.stage({
          threadId,
          name: "shot.png",
          base64: PNG_BASE64,
        });

        const events = yield* runTurn(threadId, staged.path, f);

        const said = events
          .flatMap((event) =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
              ? [event.payload.item.text ?? ""]
              : [],
          )
          .join("\n");
        // The fake only knows what it managed to read off disk, and it names
        // the staged file — which is the one the prompt pointed at.
        expect(said).toContain(`I opened ${NodePath.basename(staged.path)}`);
        expect(said).toContain("image/png, 70 bytes");
        // It saw the file through --add-dir, not by luck.
        expect(said).not.toContain("outside every --add-dir");
        // Nothing was copied: the server already staged it where it belongs.
        const entries = NodeFS.readdirSync(f.store.directoryFor(threadId));
        expect(entries).toEqual([NodePath.basename(staged.path)]);
      }),
    ),
  );
});
