import type { TerminalAttachItem } from "@OpenAde/client-runtime/terminalAtoms";
import type { TerminalId, ThreadId } from "@OpenAde/contracts/ids";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { exitLine, makeTerminalFeed } from "./terminal-feed";

// A real xterm, never opened: its parser, write queue and query answers work
// without a DOM, and the queue is what these tests are about.
const makeXterm = () => {
  const terminal = new Terminal({ cols: 40, rows: 6, scrollback: 100, allowProposedApi: true });
  const sent: Array<string> = [];
  const snapshots: Array<{ cols: number; rows: number }> = [];
  const feed = makeTerminalFeed(terminal, {
    onSnapshot: (size) => snapshots.push(size),
    onExited: () => {},
    onGone: () => {},
  });
  terminal.onData((data) => {
    if (feed.acceptsInput()) {
      sent.push(data);
    }
  });
  const lines = () => {
    const buffer = terminal.buffer.active;
    const out: Array<string> = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) ?? "";
      if (line !== "") {
        out.push(line);
      }
    }
    return out;
  };
  // Each pass lets the queue run dry; a snapshot's own writes need a second.
  const settle = async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      await new Promise<void>((resolve) => terminal.write("", resolve));
    }
  };
  return { terminal, feed, sent, snapshots, lines, settle };
};

const snapshot = (data: string, offset: number): TerminalAttachItem => ({
  kind: "snapshot",
  terminal: {
    terminalId: "0199c0de-0003-7000-8000-000000000001" as TerminalId,
    threadId: "0199c0de-0002-7000-8000-000000000001" as ThreadId,
    title: "Terminal 1",
    cwd: "/tmp",
    pid: 4242,
    cols: 40,
    rows: 6,
    status: "running",
    exitCode: null,
    createdAt: "2026-09-24T00:00:00.000Z",
  },
  data,
  offset,
});

const output = (data: string, offset: number): TerminalAttachItem => ({
  kind: "output",
  data,
  offset,
});

describe("makeTerminalFeed", () => {
  it("resets only after output still queued from before the snapshot is parsed", async () => {
    const { feed, lines, settle, snapshots } = makeXterm();
    // Written in one go, so xterm has parsed none of it when the snapshot comes.
    for (let offset = 1; offset <= 20; offset += 1) {
      feed.push(output(`old ${offset}\r\n`, offset));
    }
    feed.push({ kind: "resnapshot-required", reason: "behind" });
    feed.push(snapshot("snapshot\r\n", 20));
    await settle();
    expect(lines()).toEqual(["snapshot"]);
    expect(snapshots).toEqual([{ cols: 40, rows: 6 }]);
  });

  it("writes what arrives while the snapshot waits after it, dropping what it holds", async () => {
    const { feed, lines, settle } = makeXterm();
    feed.push(output("old\r\n", 1));
    feed.push(snapshot("snapshot\r\n", 5));
    feed.push(output("already in the snapshot\r\n", 5));
    feed.push(output("new\r\n", 6));
    feed.push({ kind: "exited", exitCode: 0, signal: null });
    await settle();
    expect(lines()).toEqual(["snapshot", "new", exitLine(0, null)]);
  });

  it("sends no answer to a query in superseded output or in the replay", async () => {
    const { feed, sent, settle } = makeXterm();
    // Device attributes and cursor position, as a prompt asks for them.
    feed.push(output("\u001b[c\u001b[6n", 1));
    feed.push(snapshot("replay\u001b[c\u001b[6n\r\n", 1));
    await settle();
    expect(sent).toEqual([]);
  });

  it("answers a query in live output, and passes keys through", async () => {
    const { terminal, feed, sent, settle } = makeXterm();
    feed.push(snapshot("$ ", 1));
    await settle();
    feed.push(output("\u001b[6n", 2));
    await settle();
    terminal.input("l");
    expect(sent).toEqual(["\u001b[1;3R", "l"]);
  });

  it("writes nothing once stopped, even for a snapshot already waiting", async () => {
    const { feed, lines, settle } = makeXterm();
    feed.push(output("before\r\n", 1));
    feed.push(snapshot("snapshot\r\n", 1));
    feed.stop();
    feed.push(output("after\r\n", 2));
    await settle();
    expect(lines()).toEqual(["before"]);
  });
});
