/**
 * Binds the git actions control's steps (`@/lib/git-actions`) to the git
 * writes, sonner and the remembered pull request link.
 *
 * Each step's toast has its own id for the run, so its "…ing" toast turns
 * into the done or failed one in place. A pull request's toast carries an
 * Open action, and its URL is remembered for the thread — or, on the New task
 * page, for the project's own folder — which is where the control's "View
 * pull request" comes from.
 */

import type { GitCommitResult, GitPullRequestResult, GitPushResult } from "@OpenAde/contracts/git";
import * as Exit from "effect/Exit";
import { toast } from "sonner";

import type { GitScope } from "@OpenAde/client-runtime/gitAtoms";

import { useGitCommands } from "@/components/panes/changes/git-atoms";
import { describeExitError } from "@/lib/app-runtime";
import { openExternal } from "@/lib/desktop";
import { workspaceKey } from "@/lib/workspace-key";
import {
  runGitSteps,
  type GitRunResult,
  type GitStep,
  type StepNotice,
  type StepOutcome,
} from "@/lib/git-actions";
import { usePullRequestLink } from "@/state/ui";

/** What the dialog decided; a commit without `paths` takes every change. */
export interface GitRunInput {
  readonly commit?: { readonly message: string; readonly paths?: ReadonlyArray<string> };
  readonly pullRequest?: { readonly title: string; readonly body: string };
}

let runs = 0;

const outcomeOf = <A>(exit: Exit.Exit<A, unknown>, fallback: string): StepOutcome<A> =>
  Exit.isSuccess(exit)
    ? { ok: true, value: exit.value }
    : { ok: false, message: describeExitError(exit, fallback) };

/** One toast per step: `loading`, then replaced in place by its outcome. */
const toastNotice = (run: number) => (notice: StepNotice) => {
  const id = `git-run-${run}-${notice.step}`;
  switch (notice.phase) {
    case "loading":
      toast.loading(notice.message, { id });
      return;
    case "success": {
      const url = notice.url;
      toast.success(notice.message, {
        id,
        ...(url === undefined
          ? {}
          : { action: { label: "Open", onClick: () => openExternal(url) } }),
      });
      return;
    }
    case "error":
      toast.error(notice.message, { id });
      return;
  }
};

/** Acts in the thread's workspace when `scope` names one, else in the project's own folder. */
export const useGitActions = (scope: GitScope) => {
  const { commit, push, openPullRequest } = useGitCommands();
  const [pullRequestUrl, rememberPullRequest] = usePullRequestLink(workspaceKey(scope));

  const run = async (
    steps: ReadonlyArray<GitStep>,
    input: GitRunInput,
    pushTarget: string | null,
  ): Promise<GitRunResult> => {
    runs += 1;
    const result = await runGitSteps(
      steps,
      {
        commit: async (): Promise<StepOutcome<GitCommitResult>> =>
          input.commit === undefined
            ? { ok: false, message: "There is no commit message." }
            : outcomeOf(
                await commit({
                  ...scope,
                  message: input.commit.message,
                  ...(input.commit.paths === undefined ? {} : { paths: input.commit.paths }),
                }),
                "The commit was refused.",
              ),
        push: async (): Promise<StepOutcome<GitPushResult>> =>
          outcomeOf(await push(scope), "The push was refused."),
        pr: async (): Promise<StepOutcome<GitPullRequestResult>> =>
          input.pullRequest === undefined
            ? { ok: false, message: "There is no pull request title." }
            : outcomeOf(
                await openPullRequest({ ...scope, ...input.pullRequest }),
                "The pull request was not opened.",
              ),
      },
      toastNotice(runs),
      pushTarget,
    );
    if (result.pullRequest !== undefined) {
      rememberPullRequest(result.pullRequest.url);
    }
    return result;
  };

  return { run, pullRequestUrl };
};
