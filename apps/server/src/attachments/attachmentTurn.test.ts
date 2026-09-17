/**
 * The whole attachment path, against a real spawned process.
 *
 * `attachments.stage` writes a real PNG, the turn carries the reference, and
 * the session copies nothing (the file is already under `attachmentsDir`),
 * passes the directory as `--add-dir` and names the absolute path in the
 * prompt. The binary is testkit's replayer, so what comes back is
 * `fixtures/cmd/image/` — a real Command Code turn staged exactly this way, in
 * which the model read the PNG and answered with the colour of its pixels.
 *
 * The assertions are therefore on the two halves that are ours: the argv and
 * prompt the connector hands the CLI, which the replay records, and the answer
 * the real CLI gave when it was handed the same thing.
 *
 * Nothing touches the real `~/.commandcode` or `~/.openade`: both are
 * redirected into a temp directory for the file.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeCmdSession } from "@OpenAde/connector-cmd/session";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import {
  loadRecording,
  replayConfig,
  replayedInvocations,
} from "@OpenAde/testkit/replayCmdProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { AttachmentStore } from "./AttachmentStore";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Fixture {
  readonly home: string;
  readonly workspace: string;
  readonly attachmentsDir: string;
  readonly argvLog: string;
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
    const argvLog = NodePath.join(root, "argv.jsonl");
    const context = yield* Layer.build(AttachmentStore.layerAt(attachmentsDir));
    return {
      home,
      workspace,
      attachmentsDir,
      argvLog,
      store: Context.get(context, AttachmentStore),
    };
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
    const replay = replayConfig("image", { home: f.home, argvLog: f.argvLog, turn: 0 });
    const handle = yield* makeCmdSession({
      instanceId: makeConnectorInstanceId(),
      threadId,
      workspaceRoot: f.workspace,
      binaryPath: replay.binaryPath,
      extraEnv: replay.extraEnv,
      home: f.home,
      services: yield* servicesFor(f.attachmentsDir),
      settings: {
        model: "meta/muse-spark-1.3-contributor",
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
  it.live("is handed over the way the recorded image turn was handed over", () =>
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

        // ── what we handed the CLI ──────────────────────────────
        const invocation = replayedInvocations(f.argvLog).at(-1);
        const argv = invocation?.argv ?? [];
        const prompt = argv[argv.indexOf("-p") + 1] ?? "";
        // The absolute path, labelled with its media type, so the model knows
        // it is an image worth reading (decision w10-attachments).
        expect(prompt).toContain(`Attachment (image/png): ${staged.path}`);
        // And the directory it lives in, or the read tool would refuse: it is
        // outside the workspace root the session was started in.
        const addDirs = argv.flatMap((arg, index) =>
          arg === "--add-dir" ? [argv[index + 1]] : [],
        );
        expect(addDirs).toEqual([f.store.directoryFor(threadId)]);
        expect(NodePath.isAbsolute(staged.path)).toBe(true);
        // Nothing was copied: the server already staged it where it belongs.
        expect(NodeFS.readdirSync(f.store.directoryFor(threadId))).toEqual([
          NodePath.basename(staged.path),
        ]);

        // ── what the real CLI did with it ───────────────────────
        const recording = loadRecording("image");
        const items = events.flatMap((event) =>
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
            ? [event.payload.item]
            : [],
        );
        // It read the staged file, and answered with the colour of the pixels.
        const read = items.filter((item) => item.tool?.name === "read_file");
        expect(String(read.at(-1)?.tool?.output ?? "")).toContain("Read image");
        const said = items.filter((item) => item.kind === "assistant_message");
        expect(said.at(-1)?.text?.toLowerCase()).toContain("red");
        expect(recording.turns[0]!.prompt).toContain("Attachment (image/png):");
      }),
    ),
  );
});
