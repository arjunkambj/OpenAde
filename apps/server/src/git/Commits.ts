/**
 * Commit and push: the two writes behind the git actions control.
 *
 * Like `Branches.ts`, this is the git half only. `Git.ts` resolves the
 * workspace root and refuses a commit while a turn runs in it; the rules git
 * itself decides — what gets staged, whether anything is, which remote a
 * branch pushes to — live here.
 *
 * Both run as the user, not as OpenAde: no author environment (that is the
 * checkpoint store's, for its hidden refs only) and never `--no-verify`, so
 * the user's identity, signing config and hooks apply exactly as they would in
 * a terminal. A hook that refuses surfaces its own output.
 */
import type { GitCommitResult, GitPushResult } from "@OpenAde/contracts/git";
import * as Effect from "effect/Effect";

import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";

import { run, type GitResult } from "./process";

const invalid = (message: string) => new OpenAdeRpcError({ code: "invalid", message });
const conflict = (message: string) => new OpenAdeRpcError({ code: "conflict", message });

/** What git said when it refused: stderr, else stdout (some hooks print there), else the code. */
const refusalText = (result: GitResult) =>
  result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`;

/** The checked-out branch, or `null` on a detached HEAD. */
const currentBranch = (cwd: string) =>
  run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowNonZeroExit: true }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
  );

// ── Commit ─────────────────────────────────────────────────────

/**
 * Stages what the commit should contain.
 *
 * Without `paths`, everything: `git add -A`, the "commit all my changes" the
 * control offers by default.
 *
 * With `paths`, only those. The index is reset first, so a file the user had
 * staged in a terminal but left unchecked in the dialog does not ride along:
 * the dialog's list is the whole commit. The cost is that such a file ends up
 * unstaged (its changes stay in the working tree), which is the lesser
 * surprise — a commit that silently carries more than the user picked cannot
 * be taken back once it is pushed. `--literal-pathspecs` makes every path
 * exactly that path, never a glob or a `:(magic)` pathspec.
 */
const stage = (cwd: string, paths: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    if (paths === undefined) {
      yield* run(cwd, ["add", "-A"]).pipe(Effect.mapError((error) => conflict(error.message)));
      return;
    }
    if (paths.length === 0) {
      return yield* Effect.fail(invalid("Choose at least one file to commit."));
    }
    yield* run(cwd, ["reset", "-q"]);
    const added = yield* run(cwd, ["--literal-pathspecs", "add", "-A", "--", ...paths], {
      allowNonZeroExit: true,
    });
    if (added.exitCode !== 0) {
      return yield* Effect.fail(invalid(refusalText(added)));
    }
  });

/**
 * Commits the working tree's changes — all of them, or only `paths` — with
 * `message`, and answers the commit that was made.
 */
export const commit = (
  cwd: string,
  options: { readonly message: string; readonly paths?: ReadonlyArray<string> | undefined },
) =>
  Effect.gen(function* () {
    yield* stage(cwd, options.paths);
    const staged = yield* run(cwd, ["diff", "--cached", "--quiet"], { allowNonZeroExit: true });
    if (staged.exitCode === 0) {
      return yield* Effect.fail(conflict("Nothing to commit."));
    }
    // `-m` means git never opens an editor; the hooks still run.
    const committed = yield* run(cwd, ["commit", "-q", "-m", options.message], {
      allowNonZeroExit: true,
    });
    if (committed.exitCode !== 0) {
      return yield* Effect.fail(conflict(refusalText(committed)));
    }
    const head = yield* run(cwd, ["log", "-1", "--format=%H%x00%s"]);
    const [sha = "", subject = ""] = head.stdout.replace(/\n$/, "").split("\0");
    return { sha, subject, branch: yield* currentBranch(cwd) } satisfies GitCommitResult;
  });

// ── Push ───────────────────────────────────────────────────────

/**
 * A push may wait on the network and a large upload, but never on a person:
 * no terminal credential prompt (it would hang this call forever, with no
 * terminal to answer it), and a ceiling that turns a stall into an error.
 */
const PUSH_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

const lines = (stdout: string) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * The remote `branch` pushes to: its configured `branch.<name>.remote`, else
 * `origin`, else the repository's only remote. `.` (a branch tracking another
 * local branch) is not a remote to push to, so it falls through.
 */
const remoteFor = (cwd: string, branch: string) =>
  Effect.gen(function* () {
    const remotes = lines((yield* run(cwd, ["remote"])).stdout);
    const configured = yield* run(cwd, ["config", "--get", `branch.${branch}.remote`], {
      allowNonZeroExit: true,
    });
    const named = configured.stdout.trim();
    if (configured.exitCode === 0 && remotes.includes(named)) return named;
    if (remotes.includes("origin")) return "origin";
    if (remotes.length === 1) return remotes[0]!;
    return yield* Effect.fail(
      new OpenAdeRpcError({
        code: "unavailable",
        message:
          remotes.length === 0
            ? "This repository has no remote to push to."
            : `This branch has no remote configured and there is no origin among ${remotes.join(", ")}.`,
      }),
    );
  });

/**
 * Pushes the current branch. With an upstream, a plain `git push`, which
 * honours the user's `push.default`. Without one, `git push -u <remote>
 * <branch>`, which pushes to a branch of the same name and records it as the
 * upstream — a branch cut `--no-track` from `origin/main` lands on its own
 * name, never on main.
 */
export const push = (cwd: string) =>
  Effect.gen(function* () {
    const branch = yield* currentBranch(cwd);
    if (branch === null) {
      return yield* Effect.fail(invalid("HEAD is detached — check out a branch before pushing."));
    }
    const remote = yield* remoteFor(cwd, branch);
    if (remote.startsWith("-") || branch.startsWith("-")) {
      return yield* Effect.fail(invalid(`Refusing to push ${branch} to ${remote}.`));
    }
    const upstream = yield* run(
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
      { allowNonZeroExit: true },
    );
    const setUpstream = upstream.exitCode !== 0;
    const args = setUpstream ? ["push", "-u", remote, branch] : ["push"];
    const pushed = yield* run(cwd, args, {
      env: PUSH_ENV,
      timeoutMs: PUSH_TIMEOUT_MS,
      allowNonZeroExit: true,
    }).pipe(Effect.mapError((error) => conflict(error.message)));
    if (pushed.exitCode !== 0) {
      return yield* Effect.fail(conflict(refusalText(pushed)));
    }
    return { remote, branch, setUpstream } satisfies GitPushResult;
  });
