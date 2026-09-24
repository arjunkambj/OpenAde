/**
 * The commit dialog the git actions control opens before any action that
 * commits: the message, and the files to include.
 *
 * The message opens as `commitMessageDraft` — the thread's title and the
 * checked paths — and is the user's to edit; nothing here writes one for
 * them. Until the user types, it follows the draft: the control refetches the
 * status as the dialog opens, and the message must list the same files as the
 * checkboxes — once that answer lands, and as files are unchecked — not the
 * ones cached before it or left out since (`commitSelection`). The first
 * keystroke makes it the user's, and nothing replaces it after that. Every
 * file `git.status` reports is listed, untracked ones included, all checked.
 * `paths` is sent only when something was unchecked; with everything checked
 * the server stages everything (`git add -A`), which also takes a file that
 * appeared after the dialog opened. The confirm button is labelled with the
 * action it runs, and disabled on an empty message.
 *
 * With every file unchecked there is nothing to commit. A plain commit is
 * disabled then; an action that also pushes or opens a pull request can still
 * do that, without the commit — the button says what is left
 * (`withoutCommitLabel`, e.g. "Push & create PR"), and the choice comes back
 * with an empty `paths`. That keeps a pull request reachable when the only
 * change left is a file the user does not want committed.
 *
 * The control mounts a fresh dialog (a new `key`) for each opening, so each
 * opening starts from the draft again.
 *
 * A long list of changes must not push the title and the buttons off-screen:
 * the message box and the file list each scroll past a fixed height, and the
 * dialog itself scrolls on a short window.
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
import { Label } from "@OpenAde/ui/components/label";
import { Textarea } from "@OpenAde/ui/components/textarea";
import type { GitFileChange } from "@OpenAde/contracts/rpc";

import { commitSelection } from "@/lib/git-actions";
import { CommitFileList } from "./commit-file-list";

export interface CommitChoice {
  readonly message: string;
  /** Absent when every file is included; empty when none is, and nothing is committed. */
  readonly paths?: ReadonlyArray<string>;
}

export function CommitDialog({
  open,
  onOpenChange,
  actionLabel,
  withoutCommitLabel,
  threadTitle,
  branch,
  files,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly actionLabel: string;
  /** The button's label with every file unchecked; `null` when nothing would be left to run. */
  readonly withoutCommitLabel: string | null;
  /** The thread's title, the subject of the suggested message. */
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly files: ReadonlyArray<GitFileChange>;
  readonly onSubmit: (choice: CommitChoice) => void;
}) {
  const [edited, setEdited] = React.useState<string | null>(null);
  const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(() => new Set());

  const { included, message, paths } = commitSelection(threadTitle, files, excluded, edited);
  const committing = included.length > 0;
  const submitLabel = committing ? actionLabel : withoutCommitLabel;
  const canSubmit = message.trim() !== "" && submitLabel !== null;

  const toggle = (path: string, include: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (include) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

  const submit = () => {
    if (!canSubmit) {
      return;
    }
    onOpenChange(false);
    onSubmit({ message: message.trim(), ...(paths === undefined ? {} : { paths }) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>
            {branch === null
              ? "Commits on a detached HEAD, with your own git identity and hooks."
              : `Commits on ${branch}, with your own git identity and hooks.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="commit-message">Message</Label>
            <Textarea
              id="commit-message"
              value={message}
              rows={6}
              autoFocus
              spellCheck
              className="max-h-48 overflow-y-auto"
              onChange={(event) => setEdited(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <CommitFileList
            files={files}
            excluded={excluded}
            onToggle={toggle}
            onToggleAll={(include) =>
              setExcluded(include ? new Set() : new Set(files.map((file) => file.path)))
            }
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitLabel ?? actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
