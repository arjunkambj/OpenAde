/**
 * The argv one turn is spawned with — and the one line of it that decides
 * whether a mode the UI calls "Plan first" is read-only or not.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { makeThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";

import { prepareTurn } from "./turnArgs";

const RECORDINGS = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../testkit/fixtures/cmd",
);

const settings = (interactionMode: ThreadSettings["interactionMode"]): ThreadSettings => ({
  model: "meta/muse-spark-1.3-contributor",
  runtimeMode: "approval-required",
  interactionMode,
});

const prepare = (interactionMode: ThreadSettings["interactionMode"]) =>
  prepareTurn({
    turn: { text: "hi", attachments: [], mentions: [] },
    settings: settings(interactionMode),
    attachmentsDir: NodePath.join(NodeFS.realpathSync(NodePath.resolve("/tmp")), "openade-none"),
    threadId: makeThreadId(),
    resumeSessionId: null,
  });

describe("prepareTurn", () => {
  it("sends --yolo on an ordinary turn", async () => {
    const prepared = await prepare("default");
    expect(prepared.args).toContain("--yolo");
    expect(prepared.args).not.toContain("--permission-mode");
    expect(prepared.plan).toBe(false);
  });

  /**
   * Plan mode fires no PreToolUse hook — `hookCount: 0` in all four plan
   * recordings, including one whose `read_file` fires a hook in an ordinary
   * run — so none of the permission ladder runs there: not the user's `deny`
   * rules, not "plan mode is read-only", not the sensitive-path prompt. Adding
   * `--yolo` on top removed the only thing left, print mode's own refusal of
   * writes and shell calls, and left a mode the UI presents as read-only with
   * no enforcement of any kind. `plan-write/` is that experiment recorded
   * against the real CLI: plan mode, `--yolo`, told outright to mutate.
   */
  it("does not send --yolo on a plan turn", async () => {
    const prepared = await prepare("plan");
    expect(prepared.plan).toBe(true);
    expect(prepared.args).not.toContain("--yolo");
    expect(prepared.args.join(" ")).toContain("--permission-mode plan");
  });

  it("spawns a plan turn the way plan-no-yolo was recorded", async () => {
    // The recording that shows what the refusal looks like: `write_file`
    // blocked with "requires permissions", and the plan's whole body sitting
    // in the `tool_queued` frame that announced it.
    const recorded = JSON.parse(
      NodeFS.readFileSync(NodePath.join(RECORDINGS, "plan-no-yolo", "manifest.json"), "utf8"),
    ) as { turns: ReadonlyArray<{ connectorArgs: ReadonlyArray<string> }> };
    const argv = recorded.turns[0]!.connectorArgs;
    const prepared = await prepare("plan");
    for (const args of [argv, prepared.args]) {
      expect(args).not.toContain("--yolo");
      expect(args.join(" ")).toContain("--permission-mode plan");
      expect(args.slice(2, 8)).toEqual([
        "--output-format",
        "json",
        "--verbose",
        "-t",
        "--skip-onboarding",
        "--no-auto-update",
      ]);
    }
  });
});
