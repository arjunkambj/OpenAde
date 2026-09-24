/**
 * Replays a recorded agent-browser run at the child-process boundary.
 *
 * The recordings under `packages/testkit/fixtures/agent-browser/cli-*` are the
 * real CLI's `--json` envelopes, taken against real pane webviews through the
 * desktop's real bridge. The replay is a `ChildRunner`: `makeAgentBrowser`
 * runs over it exactly as over `execFile`, so the envelope parse, the argv
 * and the child env are the production code's. Each run must ask for the
 * next recorded command, in order — a driver that issues anything else fails
 * the test with what it sent and what the recording did next.
 *
 * Nothing here answers a command the real CLI was not recorded answering.
 */

import * as Effect from "effect/Effect";

import { readManifest } from "@poseidon/testkit/recording";

import { makeAgentBrowser, type ChildRunner } from "../agentBrowser";

interface RecordedStep {
  readonly argv?: ReadonlyArray<string>;
  readonly exitCode?: number;
  readonly envelope?: unknown;
  /** `{host: "remove", index}` — the pane closed that tab between commands. */
  readonly host?: string;
}

interface CliManifest {
  readonly threadId: string;
  /** The thread's tabs before the CLI connected, in pane order. */
  readonly tabs: ReadonlyArray<{ readonly targetId: string; readonly url: string }>;
  readonly steps: ReadonlyArray<RecordedStep>;
}

/** One child run as the runner saw it. */
export interface ReplayedRun {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** The namespace every replayed run carries, as the server's would. */
const REPLAY_NAMESPACE = "poseidon-replay";

/** A bridge of the right shape; the recordings scrubbed the real key and port. */
const REPLAY_BRIDGE = { base: "ws://127.0.0.1:47000", key: "0".repeat(64) } as const;

export const replayCli = (scenario: string) => {
  const manifest = readManifest<CliManifest>("agent-browser", scenario);
  const commands = manifest.steps.filter(
    (step): step is RecordedStep & { readonly argv: ReadonlyArray<string> } =>
      step.argv !== undefined,
  );
  const runs: Array<ReplayedRun> = [];
  let next = 0;

  const run: ChildRunner = (_binary, args, options) =>
    Effect.sync(() => {
      runs.push({ args, env: options.env });
      // `--session <name> --json` lead every invocation; the rest is the command.
      const argv = args.slice(3);
      const step = commands[next];
      if (step === undefined || JSON.stringify(step.argv) !== JSON.stringify(argv)) {
        throw new Error(
          `replay ${scenario}: sent \`${argv.join(" ")}\`, the recording ran ` +
            (step === undefined ? "nothing more" : `\`${step.argv.join(" ")}\``),
        );
      }
      next += 1;
      return {
        stdout: JSON.stringify(step.envelope),
        stderr: "",
        error: step.exitCode === 0 ? null : `Command failed: exit code ${step.exitCode}`,
      };
    });

  const agentBrowser = makeAgentBrowser({
    binary: "agent-browser",
    version: "0.38.1",
    bridge: REPLAY_BRIDGE,
    env: { HOME: "/home/someone", PATH: "/usr/bin" },
    namespace: REPLAY_NAMESPACE,
    run,
  });

  return {
    threadId: manifest.threadId,
    tabs: manifest.tabs,
    agentBrowser,
    session: agentBrowser.session(manifest.threadId),
    runs,
    /** Recorded commands nobody asked for yet. */
    remaining: () => commands.slice(next).map((step) => step.argv.join(" ")),
  };
};
