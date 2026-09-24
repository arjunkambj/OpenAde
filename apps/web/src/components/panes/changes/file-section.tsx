/**
 * One file of the Changes list: a compact row that sticks to the top while
 * its patch scrolls under it, and the patch itself once the row is opened. A
 * closed file keeps nothing mounted, so a long list of closed rows costs no
 * highlighting at all.
 */

import type { GitDiffFile } from "@OpenAde/contracts/rpc";

import { InlineDiff } from "@/components/timeline/diff-pool";
import { cn } from "@/lib/utils";
import type { DiffStyle } from "@/state/ui";

import { type HoneyIcon, ChevronRight, Edit, FileAdd, FileRemove } from "@honeyicons/react";

const KIND_ICON: Record<GitDiffFile["kind"], HoneyIcon> = {
  create: FileAdd,
  edit: Edit,
  delete: FileRemove,
};

/** `+12 −3`, each side only when it is not zero. */
export function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
      {additions > 0 ? <span className="text-added">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-removed">−{deletions}</span> : null}
    </span>
  );
}

/** A path as a muted directory and a bright file name, the name never cut. */
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 font-mono text-xs" title={path}>
      {slash === -1 ? null : (
        <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, slash + 1)}</span>
      )}
      <span className="shrink-0 text-foreground">{path.slice(slash + 1)}</span>
    </span>
  );
}

export function FileSection({
  file,
  open,
  onOpenChange,
  diffStyle,
}: {
  file: GitDiffFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diffStyle: DiffStyle;
}) {
  const Glyph = KIND_ICON[file.kind];
  const expandable = file.diff !== "";
  return (
    <section>
      <div className="sticky top-0 z-10 flex h-7 items-center border-b border-border bg-sidebar hover:bg-hover">
        <button
          type="button"
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          onClick={() => onOpenChange(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset enabled:cursor-pointer"
        >
          <ChevronRight
            variant="bold"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
              open && expandable && "rotate-90",
              !expandable && "invisible",
            )}
          />
          <Glyph variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
          {file.oldPath === undefined ? (
            <FilePath path={file.path} />
          ) : (
            <span className="flex min-w-0 flex-1 gap-1 font-mono text-xs">
              <span className="min-w-0 truncate text-muted-foreground">{file.oldPath} →</span>
              <FilePath path={file.path} />
            </span>
          )}
          <LineCounts additions={file.additions} deletions={file.deletions} />
        </button>
      </div>
      {open && expandable ? (
        <div className="border-b border-border">
          <InlineDiff patch={file.diff} diffStyle={diffStyle} className="rounded-none" />
        </div>
      ) : null}
    </section>
  );
}
