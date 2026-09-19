/**
 * The one decision `sessionRef.ts` makes: may this session be resumed?
 *
 * It is a filesystem question — the harness refuses `--session <id>` unless it
 * can find `<id>.jsonl` — so the test writes real transcripts under a real
 * temp home rather than stubbing the lookup.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";

import { makeSessionRefLocator, type CmdSessionRef } from "./sessionRef";
import { transcriptPathFor } from "./transcript";

const TMP = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "session-ref-"));
const HOME = NodePath.join(TMP, "home");
const ROOT = NodePath.join(TMP, "workspace");
NodeFS.mkdirSync(HOME, { recursive: true });
NodeFS.mkdirSync(ROOT, { recursive: true });

afterAll(() => {
  NodeFS.rmSync(TMP, { recursive: true, force: true });
});

const locator = makeSessionRefLocator({ root: ROOT, home: HOME });

const refFor = (sessionId: string): CmdSessionRef => ({
  sessionId,
  transcriptPath: locator.pathOf(sessionId),
  cwd: ROOT,
  lastMessageId: null,
});

/** Writes a transcript where the harness would have put one for this session. */
const writeTranscript = (sessionId: string): void => {
  const path = transcriptPathFor(ROOT, sessionId, HOME);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, '{"type":"message"}\n', "utf8");
};

describe("resuming a session", () => {
  it("resumes one whose transcript is on disk", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeTranscript(sessionId);
    const ref = refFor(sessionId);
    expect(locator.resumable(ref)).toBe(ref);
  });

  it("refuses one whose transcript was never written", () => {
    // What a SIGINT leaves behind: the id arrived on `run_start`, the process
    // died before the harness flushed a transcript, and `--session <id>` would
    // now fail the whole run with "neither an existing .jsonl transcript nor a
    // known session-id prefix" — every turn after the user pressed Stop.
    const ref = refFor("22222222-2222-4222-8222-222222222222");
    expect(locator.resumable(ref)).toBeNull();
  });

  it("passes a session-less thread through untouched", () => {
    // A first turn has nothing to resume, and that is not a failure to warn
    // about.
    expect(locator.resumable(null)).toBeNull();
  });

  it("finds a transcript the harness filed under another project slug", () => {
    // The slug is a guess at a private naming scheme; the session id is not.
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const elsewhere = NodePath.join(HOME, ".commandcode", "projects", "some-other-slug");
    NodeFS.mkdirSync(elsewhere, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(elsewhere, `${sessionId}.jsonl`), "{}\n", "utf8");
    expect(locator.resumable(refFor(sessionId))).not.toBeNull();
  });
});
