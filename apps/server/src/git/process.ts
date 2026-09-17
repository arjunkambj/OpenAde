/**
 * The one place `git` is invoked: argv-form `execFile`, never a shell. Every
 * git operation in this directory goes through `run` so quoting, output caps
 * and error shaping stay consistent.
 */
import { execFile } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class GitError extends Data.TaggedError("GitError")<{
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly message: string;
}> {}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  /** Tolerate a non-zero exit — the caller inspects `exitCode` itself. */
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 32 * 1024 * 1024;

export const run = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): Effect.Effect<GitResult, GitError> =>
  Effect.callback<GitResult, GitError>((resume) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
      },
      (error, stdout, stderr) => {
        // A numeric code is the child's exit status; anything else — a string
        // like "ENOENT" or "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", or null on a
        // signal kill — means the process never produced a result, so this
        // must fail rather than report exit 0 with empty output.
        if (error !== null && typeof error.code !== "number") {
          resume(
            Effect.fail(
              new GitError({
                command: `git ${args.join(" ")}`,
                cwd,
                exitCode: null,
                message: error.message,
              }),
            ),
          );
          return;
        }
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        if (exitCode !== 0 && options.allowNonZeroExit !== true) {
          resume(
            Effect.fail(
              new GitError({
                command: `git ${args.join(" ")}`,
                cwd,
                exitCode,
                message: stderr.trim() || `git exited ${exitCode}`,
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed({ stdout, stderr, exitCode }));
      },
    );
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }
    return Effect.sync(() => child.kill("SIGKILL"));
  });
