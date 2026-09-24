/**
 * The commit dialog's file list: every path `git.status` reports — untracked
 * files included — with a checkbox each, all checked unless the user unchecks
 * them. An untracked file is not always work the user wants committed (a
 * scratch file, a local note), which is why it is listed and can be left out.
 * The harness's own hook config never shows up here: the connector keeps it in
 * the repository's `info/exclude` while a session holds it.
 *
 * The dialog keeps the *unchecked* paths, not the checked ones, so a file that
 * appears while the dialog is open starts checked like the rest.
 */

import { Checkbox } from "@OpenAde/ui/components/checkbox";
import type { GitFileChange } from "@OpenAde/contracts/rpc";

import { cn } from "@/lib/utils";

const STATUS_LETTER: Record<GitFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

const STATUS_LABEL: Record<GitFileChange["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
};

export function CommitFileList({
  files,
  excluded,
  onToggle,
  onToggleAll,
}: {
  readonly files: ReadonlyArray<GitFileChange>;
  readonly excluded: ReadonlySet<string>;
  readonly onToggle: (path: string, included: boolean) => void;
  readonly onToggleAll: (included: boolean) => void;
}) {
  const included = files.filter((file) => !excluded.has(file.path)).length;
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={included === files.length && files.length > 0}
          onCheckedChange={(checked) => onToggleAll(checked === true)}
        />
        <span>
          {included} of {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      </label>
      <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1">
        {files.map((file) => (
          <li key={file.path}>
            <label className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-hover">
              <Checkbox
                checked={!excluded.has(file.path)}
                onCheckedChange={(checked) => onToggle(file.path, checked === true)}
              />
              <span
                title={STATUS_LABEL[file.status]}
                className={cn(
                  "w-3 shrink-0 font-mono text-xs",
                  file.status === "deleted" && "text-removed",
                  (file.status === "added" || file.status === "untracked") && "text-added",
                  (file.status === "modified" || file.status === "renamed") &&
                    "text-muted-foreground",
                )}
              >
                {STATUS_LETTER[file.status]}
              </span>
              <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
                {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
