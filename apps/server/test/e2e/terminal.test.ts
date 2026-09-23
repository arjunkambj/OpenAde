/**
 * Scenario (k): the integrated terminal, over the real wire.
 *
 * A booted server, a client on its WebSocket, and a thread on the harness's
 * temp workspace; then every terminal call a drawer makes, in the order it
 * makes them. The shell is found the way the product finds it, from `$SHELL`,
 * and started as a login shell; the scenario points `$SHELL` at `/bin/sh` and
 * `HOME` at its temp dir for its duration, so the operator's own shell and rc
 * files cannot change what the terminal prints. The one assertion on output
 * is a value the shell computed.
 *
 * No agent harness is involved, so there is no recording to replay and nothing
 * the live driver would add: the scenario runs once, outside `forEachDriver`,
 * with no connector configured at all.
 */

import { makeStreamCollector } from "@OpenAde/connector-sdk/streamCollector";
import { makeTerminalId } from "@OpenAde/contracts/ids";
import type { TerminalStreamItem } from "@OpenAde/contracts/terminal";
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
});
