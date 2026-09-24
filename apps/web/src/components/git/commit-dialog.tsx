/**
 * The commit dialog the git actions control opens before any action that
 * commits: one button per action — Commit, Commit & push, and Commit & create
 * PR. The X in the corner (or Escape) aborts.
 *
 * There is no message box and no file list. The commit takes every change in
 * the workspace (the server stages everything with `git add -A`) under
 * `commitMessageDraft` — the thread's title and the changed paths — and the
 * description shows its subject, so the user sees what the commit will be
 * called.
 *
 * The action the dialog was opened for — the header's Commit or a key — is
 * the filled button and has the focus, so Enter runs it; the others are
 * outlined. A button whose action cannot run is disabled, and its tooltip
 * says why (`reasons`, from the control's `availableActions`).
 *
 * The dialog scrolls on a short window.
 */

import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@OpenAde/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { GitFileChange } from "@OpenAde/contracts/rpc";

import { commitSelection, GIT_ACTIONS, type GitAction } from "@/lib/git-actions";

export interface CommitChoice {
  readonly message: string;
}

/** The dialog's buttons sit side by side, so the pull request's leaves the push unsaid. */
const BUTTON_LABEL: Record<GitAction, string> = {
  commit: "Commit",
  "commit-push": "Commit & push",
  "commit-push-pr": "Commit & create PR",
};

export function CommitDialog({
  open,
  onOpenChange,
  initialAction,
  reasons,
  threadTitle,
  branch,
  files,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The action the dialog was opened for: the filled, focused button. */
  readonly initialAction: GitAction;
  /** Why each action cannot run; `null` when it can. */
  readonly reasons: Readonly<Record<GitAction, string | null>>;
  /** The thread's title, the subject of the commit message. */
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly files: ReadonlyArray<GitFileChange>;
  readonly onSubmit: (action: GitAction, choice: CommitChoice) => void;
}) {
  const primary = React.useRef<HTMLButtonElement>(null);

  const { message } = commitSelection(threadTitle, files, new Set());
  const subject = message.split("\n")[0] ?? "";

  const submit = (action: GitAction) => {
    onOpenChange(false);
    onSubmit(action, { message });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        initialFocus={primary}
      >
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            {`Commits on ${branch ?? "a detached HEAD"} as “${subject}”, with your own git identity and hooks.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {GIT_ACTIONS.map((action) => {
            const reason = reasons[action];
            const button = (
              <Button
                ref={action === initialAction ? primary : undefined}
                type="button"
                variant={action === initialAction ? "default" : "outline"}
                disabled={reason !== null}
                onClick={() => submit(action)}
              >
                {BUTTON_LABEL[action]}
              </Button>
            );
            return reason === null ? (
              <React.Fragment key={action}>{button}</React.Fragment>
            ) : (
              <Tooltip key={action}>
                <TooltipTrigger render={<span className="inline-flex *:w-full" />}>
                  {button}
                </TooltipTrigger>
                <TooltipContent>{reason}</TooltipContent>
              </Tooltip>
            );
          })}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
