/**
 * Scenario (k): the integrated terminal, over the real wire.
 *
 * A booted server, a client on its WebSocket, and a thread on the harness's
 * temp workspace; then every terminal call a drawer makes, in the order it
 * makes them — and again for a terminal the project owns, the one the New task
 * page opens before any thread exists. The shell is found the way the product
 * finds it, from `$SHELL`, and started as a login shell; the scenario points
 * `$SHELL` at `/bin/sh` and `HOME` at its temp dir for its duration, so the
 * operator's own shell and rc files cannot change what the terminal prints.
 * The one assertion on output is a value the shell computed.
 *
 * No agent harness is involved, so there is no recording to replay and nothing
 * the live driver would add: the scenario runs once, outside `forEachDriver`,
 * with no connector configured at all.
 */

import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeTerminalId } from "@poseidon/contracts/ids";
import type { TerminalStreamItem } from "@poseidon/contracts/terminal";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  bootServer,
  connect,
  makeHome,
  openThread,
  seedSettings,
  staticCredentials,
} from "./harness";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Sets `name` for the calling scope and puts the previous value back when it closes. */
const scopedEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      process.env[name] = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

/** Everything the subscriber has been shown, snapshot and output alike. */
const transcript = (
  stream: Stream.Stream<TerminalStreamItem, unknown>,
): Stream.Stream<{ readonly item: TerminalStreamItem; readonly text: string }, unknown> =>
  stream.pipe(
    Stream.mapAccum(
      () => "",
      (text, item) => {
        const next = item.kind === "snapshot" || item.kind === "output" ? text + item.data : text;
        return [next, [{ item, text: next }]] as const;
      },
    ),
  );

describe.skipIf(process.platform === "win32")("terminal over the wire", () => {
  it.live("opens a shell, runs a command, resizes and closes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("terminal");
        yield* seedSettings(home, []);
        // Read when the terminal service is built, so before the boot.
        yield* scopedEnv("SHELL", "/bin/sh");
        yield* scopedEnv("HOME", home.root);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const { threadId } = yield* openThread(client, home);
        const rpc = yield* client.rpc;
        const terminalId = makeTerminalId();

        const opened = yield* rpc["terminal.open"]({
          threadId,
          terminalId,
          cols: 80,
          rows: 24,
          title: "e2e",
        }).pipe(Effect.orDie);
        expect(opened).toMatchObject({ terminalId, threadId, title: "e2e", status: "running" });

        const output = yield* makeStreamCollector(
          transcript(rpc["terminal.subscribe"]({ threadId, terminalId })),
        );
        yield* rpc["terminal.write"]({ threadId, terminalId, data: "echo $((20+22))\n" }).pipe(
          Effect.orDie,
        );
        yield* output.awaitItem(({ text }) => /(^|\n)42\r?\n/.test(text)).pipe(Effect.orDie);

        const listed = yield* rpc["terminal.list"]({ threadId }).pipe(Effect.orDie);
        expect(listed.map((summary) => summary.terminalId)).toEqual([terminalId]);

        yield* rpc["terminal.resize"]({ threadId, terminalId, cols: 100, rows: 30 }).pipe(
          Effect.orDie,
        );
        const [resized] = yield* rpc["terminal.list"]({ threadId }).pipe(Effect.orDie);
        expect(resized).toMatchObject({ cols: 100, rows: 30 });

        yield* rpc["terminal.close"]({ threadId, terminalId }).pipe(Effect.orDie);
        yield* output.awaitItem(({ item }) => item.kind === "exited").pipe(Effect.orDie);
        yield* output.awaitDone;
        expect(yield* rpc["terminal.list"]({ threadId }).pipe(Effect.orDie)).toEqual([]);
      }),
    ),
  );

  // The New task page's terminal: owned by the project, since no thread exists yet.
  it.live("opens a project's shell, apart from its thread's terminals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("terminal-project");
        yield* seedSettings(home, []);
        yield* scopedEnv("SHELL", "/bin/sh");
        yield* scopedEnv("HOME", home.root);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const { projectId, threadId } = yield* openThread(client, home);
        const rpc = yield* client.rpc;
        const terminalId = makeTerminalId();

        const opened = yield* rpc["terminal.open"]({
          projectId,
          terminalId,
          cols: 80,
          rows: 24,
        }).pipe(Effect.orDie);
        expect(opened).toMatchObject({ terminalId, projectId, status: "running" });

        const output = yield* makeStreamCollector(
          transcript(rpc["terminal.subscribe"]({ projectId, terminalId })),
        );
        yield* rpc["terminal.write"]({ projectId, terminalId, data: "echo $((6*7))\n" }).pipe(
          Effect.orDie,
        );
        yield* output.awaitItem(({ text }) => /(^|\n)42\r?\n/.test(text)).pipe(Effect.orDie);

        const byProject = yield* rpc["terminal.list"]({ projectId }).pipe(Effect.orDie);
        expect(byProject.map((summary) => summary.terminalId)).toEqual([terminalId]);
        expect(yield* rpc["terminal.list"]({ threadId }).pipe(Effect.orDie)).toEqual([]);

        yield* rpc["terminal.close"]({ projectId, terminalId }).pipe(Effect.orDie);
        yield* output.awaitItem(({ item }) => item.kind === "exited").pipe(Effect.orDie);
        yield* output.awaitDone;
        expect(yield* rpc["terminal.list"]({ projectId }).pipe(Effect.orDie)).toEqual([]);
      }),
    ),
  );

  // The first message on New task starts a local thread: the project's shells go with it.
  it.live("hands a project's shell to the local thread started from it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome("terminal-adopt");
        yield* seedSettings(home, []);
        yield* scopedEnv("SHELL", "/bin/sh");
        yield* scopedEnv("HOME", home.root);
        const server = yield* bootServer(home);
        const client = yield* connect(Effect.succeed(staticCredentials(server)));
        const { projectId, threadId } = yield* openThread(client, home);
        const rpc = yield* client.rpc;
        const terminalId = makeTerminalId();

        yield* rpc["terminal.open"]({ projectId, terminalId, cols: 80, rows: 24 }).pipe(
          Effect.orDie,
        );
        yield* rpc["terminal.write"]({ projectId, terminalId, data: "echo $((6*7))\n" }).pipe(
          Effect.orDie,
        );
        const before = yield* makeStreamCollector(
          transcript(rpc["terminal.subscribe"]({ projectId, terminalId })),
        );
        yield* before.awaitItem(({ text }) => /(^|\n)42\r?\n/.test(text)).pipe(Effect.orDie);

        const moved = yield* rpc["terminal.adopt"]({ projectId, threadId }).pipe(Effect.orDie);
        expect(moved).toEqual([expect.objectContaining({ terminalId, threadId })]);
        expect(yield* rpc["terminal.list"]({ projectId }).pipe(Effect.orDie)).toEqual([]);

        const after = yield* makeStreamCollector(
          transcript(rpc["terminal.subscribe"]({ threadId, terminalId })),
        );
        yield* rpc["terminal.write"]({ threadId, terminalId, data: "echo $((7*8))\n" }).pipe(
          Effect.orDie,
        );
        // The thread's subscriber has the output from before the hand-over, and
        // the one from before it keeps streaming.
        yield* after
          .awaitItem(({ text }) => /(^|\n)42\r?\n/.test(text) && /(^|\n)56\r?\n/.test(text))
          .pipe(Effect.orDie);
        yield* before.awaitItem(({ text }) => /(^|\n)56\r?\n/.test(text)).pipe(Effect.orDie);
        yield* rpc["terminal.close"]({ threadId, terminalId }).pipe(Effect.orDie);
      }),
    ),
  );
});
