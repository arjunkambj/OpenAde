/**
 * A turn's attachments as the CLI takes them: images as content blocks, any
 * other file named by path inside the thread's attachments directory, and the
 * user message that carries both. Real files in a temp directory; the PNG is
 * the 2×2 red image the Command Code recordings were made with.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeThreadId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "vitest";

import { stageAttachments } from "./attachments";
import { userMessage } from "./userMessage";

const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

const setup = () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-att-")),
  );
  const attachmentsDir = NodePath.join(root, "attachments");
  const threadId = makeThreadId();
  const staged = NodePath.join(attachmentsDir, threadId);
  NodeFS.mkdirSync(staged, { recursive: true });
  const elsewhere = NodePath.join(root, "elsewhere");
  NodeFS.mkdirSync(elsewhere);
  const write = (dir: string, name: string, bytes: string | Buffer) => {
    const path = NodePath.join(dir, name);
    NodeFS.writeFileSync(path, bytes);
    return path;
  };
  return { attachmentsDir, threadId, staged, elsewhere, write };
};

describe("stageAttachments", () => {
  it("sends an image as a base64 content block, typed by its bytes", async () => {
    const { attachmentsDir, threadId, staged, write } = setup();
    const png = write(staged, "abc-red.png", Buffer.from(RED_PNG_BASE64, "base64"));
    const result = await stageAttachments({
      attachmentsDir,
      threadId,
      // The reference claims a type the bytes do not bear out; the bytes win.
      attachments: [{ path: png, mime: "image/jpeg", name: "red.png" }],
    });
    expect(result).toEqual({
      images: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: RED_PNG_BASE64 },
        },
      ],
      promptLines: [],
      warnings: [],
    });
  });

  it("names a file that is not an image by path, whatever it is called", async () => {
    const { attachmentsDir, threadId, staged, write } = setup();
    const notes = write(staged, "notes.png", "not a picture\n");
    const result = await stageAttachments({
      attachmentsDir,
      threadId,
      attachments: [{ path: notes, mime: "text/plain" }],
    });
    expect(result).toEqual({
      images: [],
      promptLines: [`Attachment (text/plain): ${notes}`],
      warnings: [],
    });
  });

  it("copies a file from elsewhere into the thread's directory and names the copy", async () => {
    const { attachmentsDir, threadId, staged, elsewhere, write } = setup();
    const source = write(elsewhere, "report.txt", "numbers\n");
    const result = await stageAttachments({
      attachmentsDir,
      threadId,
      attachments: [{ path: source, name: "../../report.txt", sha256: "0123456789abcdef" }],
    });
    const copy = NodePath.join(staged, "0123456789ab-report.txt");
    expect(result.promptLines).toEqual([`Attachment: ${copy}`]);
    expect(NodeFS.readFileSync(copy, "utf8")).toBe("numbers\n");
    expect(result.warnings).toEqual([]);
  });

  it("keeps a file it cannot read in the prompt, and says so", async () => {
    const { attachmentsDir, threadId, elsewhere } = setup();
    const missing = NodePath.join(elsewhere, "gone.png");
    const result = await stageAttachments({
      attachmentsDir,
      threadId,
      attachments: [{ path: missing, mime: "image/png", name: "gone.png" }],
    });
    expect(result.images).toEqual([]);
    expect(result.promptLines).toEqual([`Attachment (image/png): ${missing}`]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("could not read the attachment gone.png");
  });

  it("keeps the order: images in turn, lines in turn", async () => {
    const { attachmentsDir, threadId, staged, write } = setup();
    const png = write(staged, "a.png", Buffer.from(RED_PNG_BASE64, "base64"));
    const text = write(staged, "b.txt", "b\n");
    const png2 = write(staged, "c.png", Buffer.from(RED_PNG_BASE64, "base64"));
    const result = await stageAttachments({
      attachmentsDir,
      threadId,
      attachments: [{ path: png }, { path: text }, { path: png2 }],
    });
    expect(result.images).toHaveLength(2);
    expect(result.promptLines).toEqual([`Attachment: ${text}`]);
  });
});

describe("userMessage", () => {
  const image = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png" as const, data: RED_PNG_BASE64 },
  };

  it("is a plain string without images, so a slash command stays one", () => {
    const message = userMessage({ text: "/compact", attachments: [], mentions: [] });
    expect(message.message).toEqual({ role: "user", content: "/compact" });
    expect(message.parent_tool_use_id).toBeNull();
    expect(message.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("puts mentions and the lines of files named by path after the text", () => {
    const message = userMessage(
      { text: "Look", attachments: [], mentions: ["src/a.ts"] },
      { images: [], promptLines: ["Attachment: /x/b.txt"] },
    );
    expect(message.message.content).toBe("Look\n@src/a.ts\nAttachment: /x/b.txt");
  });

  it("sends images ahead of the text, which goes last", () => {
    const message = userMessage(
      { text: "What colour is it?", attachments: [], mentions: [] },
      { images: [image], promptLines: [] },
    );
    expect(message.message.content).toEqual([image, { type: "text", text: "What colour is it?" }]);
  });

  it("sends an image with no text as the image alone", () => {
    const message = userMessage(
      { text: "", attachments: [], mentions: [] },
      { images: [image], promptLines: [] },
    );
    expect(message.message.content).toEqual([image]);
  });
});
