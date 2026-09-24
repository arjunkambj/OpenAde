/**
 * Getting a turn's files to where the harness can read them: what is already
 * staged stays put, what is not is copied in, and neither the prompt nor the
 * `--add-dir` list can be made to point outside the thread's directory.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { stageTurnAttachments } from "./attachments";

const THREAD = "0199c0de-0002-7000-8000-000000000001" as ThreadId;

const tempRoot = () => mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-cmd-attachments-"));

describe("stageTurnAttachments", () => {
  it("asks for nothing when the turn has no attachments", async () => {
    const staged = await stageTurnAttachments({
      attachmentsDir: tempRoot(),
      threadId: THREAD,
      attachments: [],
    });
    expect(staged).toEqual({ promptLines: [], addDirs: [], warnings: [] });
  });

  it("leaves a file the server already staged where it is", async () => {
    const attachmentsDir = tempRoot();
    const directory = NodePath.join(attachmentsDir, THREAD);
    mkdirSync(directory, { recursive: true });
    const path = NodePath.join(directory, "abc123-shot.png");
    writeFileSync(path, "PNG");

    const staged = await stageTurnAttachments({
      attachmentsDir,
      threadId: THREAD,
      attachments: [{ path, mime: "image/png", name: "shot.png" }],
    });

    expect(staged.promptLines).toEqual([`Attachment (image/png): ${path}`]);
    expect(staged.addDirs).toEqual([directory]);
    expect(staged.warnings).toEqual([]);
  });

  it("copies a file from outside into the thread's directory and names the copy", async () => {
    const attachmentsDir = tempRoot();
    const elsewhere = NodePath.join(tempRoot(), "holiday.png");
    writeFileSync(elsewhere, "PNGDATA");

    const staged = await stageTurnAttachments({
      attachmentsDir,
      threadId: THREAD,
      attachments: [
        {
          path: elsewhere,
          mime: "image/png",
          name: "holiday.png",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      ],
    });

    const expected = NodePath.join(attachmentsDir, THREAD, "0123456789ab-holiday.png");
    expect(staged.promptLines).toEqual([`Attachment (image/png): ${expected}`]);
    expect(readFileSync(expected, "utf8")).toBe("PNGDATA");
    expect(staged.warnings).toEqual([]);
  });

  it("cannot be made to write outside the thread's directory by a name", async () => {
    const attachmentsDir = tempRoot();
    const elsewhere = NodePath.join(tempRoot(), "x.png");
    writeFileSync(elsewhere, "PNGDATA");

    const staged = await stageTurnAttachments({
      attachmentsDir,
      threadId: THREAD,
      attachments: [{ path: elsewhere, mime: "image/png", name: "../../../escaped.png" }],
    });

    const directory = NodePath.join(attachmentsDir, THREAD);
    for (const line of staged.promptLines) {
      expect(line).toContain(directory + NodePath.sep);
      expect(line).not.toContain("..");
    }
  });

  it("warns and falls back to the original path when the copy fails", async () => {
    const attachmentsDir = tempRoot();
    const missing = NodePath.join(tempRoot(), "never-written.png");

    const staged = await stageTurnAttachments({
      attachmentsDir,
      threadId: THREAD,
      attachments: [{ path: missing, mime: "image/png", name: "never-written.png" }],
    });

    expect(staged.warnings).toHaveLength(1);
    expect(staged.warnings[0]).toContain("never-written.png");
    // The turn still goes out, pointing at what the caller gave us.
    expect(staged.promptLines).toEqual([`Attachment (image/png): ${missing}`]);
  });

  it("keeps two attachments with no content hash apart", async () => {
    const attachmentsDir = tempRoot();
    const source = tempRoot();
    const first = NodePath.join(source, "a", "shot.png");
    const second = NodePath.join(source, "b", "shot.png");
    mkdirSync(NodePath.dirname(first), { recursive: true });
    mkdirSync(NodePath.dirname(second), { recursive: true });
    writeFileSync(first, "ONE");
    writeFileSync(second, "TWO");

    const staged = await stageTurnAttachments({
      attachmentsDir,
      threadId: THREAD,
      attachments: [{ path: first }, { path: second }],
    });

    expect(new Set(staged.promptLines).size).toBe(2);
    const directory = NodePath.join(attachmentsDir, THREAD);
    expect(readFileSync(NodePath.join(directory, "0-shot.png"), "utf8")).toBe("ONE");
    expect(readFileSync(NodePath.join(directory, "1-shot.png"), "utf8")).toBe("TWO");
    // No declared type: the line still names the path, without a claim.
    expect(staged.promptLines[0]).toBe(`Attachment: ${NodePath.join(directory, "0-shot.png")}`);
  });
});
