/**
 * A comparison's files once its diff has answered, with the thread's review
 * over them (`useChangesReview`, the rules in `./review`).
 *
 * One line above the files sums the comparison up — how many files, how many
 * lines, how many the user has viewed — with the toggle that opens or closes
 * them all at once. It stays put and the files scroll under it.
 *
 * The list answers `changes.nextFile` and `changes.previousFile` while it is
 * on screen: each opens the file it lands on and scrolls that file's header to
 * the top (`stepFile` picks which). A file a link asks for (`reveal`) is
 * opened and scrolled to the same way, once, as soon as the files are in.
 */

import type { GitDiffFile } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { useKeybindingCommand } from "@/lib/shortcuts";
import { useChangesReview, type DiffStyle } from "@/state/ui";

import { FileSection, LineCounts } from "./file-section";
import {
  everyFileOpen,
  isOpen,
  isViewed,
  patchHash,
  startsOpen,
  stepFile,
  viewedCount,
  withOpen,
  withViewed,
} from "./review";
import { UnfoldLess, UnfoldMore } from "@honeyicons/react";

/**
 * The line over the files: `3 files · +20 −4 · 1 viewed`, and the toggle that
 * opens every file or closes them all.
 */
function ReviewSummary({
  files,
  viewed,
  allOpen,
  onAllOpenChange,
}: {
  files: ReadonlyArray<GitDiffFile>;
  viewed: number;
  allOpen: boolean;
  onAllOpenChange: (open: boolean) => void;
}) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const label = allOpen ? "Collapse all files" : "Expand all files";
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border pr-2 pl-3 type-micro text-muted-foreground">
      <span className="shrink-0">
        {files.length} {files.length === 1 ? "file" : "files"}
      </span>
      {additions > 0 || deletions > 0 ? (
        <>
          <span aria-hidden>·</span>
          <LineCounts additions={additions} deletions={deletions} />
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span className="shrink-0">{viewed} viewed</span>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              disabled={!allOpen && files.every((file) => file.diff === "")}
              onClick={() => onAllOpenChange(!allOpen)}
            />
          }
        >
          {allOpen ? <UnfoldLess variant="bold" /> : <UnfoldMore variant="bold" />}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Scrolls the list so `section`'s header sits at its top. Only the list's own
 * scroller moves: `scrollIntoView` would also scroll every clipping ancestor,
 * and the dock is one while it animates open — a link that opens it would
 * shift it sideways.
 */
const scrollToSection = (scroller: HTMLElement, section: Element | undefined) => {
  if (section !== undefined) {
    scroller.scrollTop +=
      section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }
};

export function ReviewList({
  threadId,
  files,
  diffStyle,
  reveal,
  onRevealed,
}: {
  threadId: string;
  files: ReadonlyArray<GitDiffFile>;
  diffStyle: DiffStyle;
  reveal: string | null;
  onRevealed: () => void;
}) {
  const [review, updateReview] = useChangesReview(threadId);
  const byDefault = startsOpen(files);
  // Hashed once per answer from git, not per render: a patch can be megabytes.
  const hashed = React.useMemo(
    () => files.map((file) => ({ file, path: file.path, hash: patchHash(file.diff) })),
    [files],
  );
  const setOpen = (paths: ReadonlyArray<string>, open: boolean) =>
    updateReview((current) => withOpen(current, paths, open));

  // The file the keys last moved to, or the one last clicked. By path, so a
  // refresh that reorders or drops files cannot point it at another one.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const cursor = React.useRef<string | null>(null);
  const step = (direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    // One `<section>` per file, in file order.
    const sections = [...scroller.children];
    const top = scroller.getBoundingClientRect().top;
    const target = stepFile(
      sections.map((section) => section.getBoundingClientRect().top - top),
      scroller.clientHeight,
      files.findIndex((file) => file.path === cursor.current),
      direction,
    );
    const file = target === null ? undefined : files[target];
    if (target === null || file === undefined) {
      return;
    }
    cursor.current = file.path;
    if (file.diff !== "") {
      setOpen([file.path], true);
    }
    scrollToSection(scroller, sections[target]);
  };
  useKeybindingCommand("changes.nextFile", () => step(1));
  useKeybindingCommand("changes.previousFile", () => step(-1));

  // A file this comparison does not have is dropped all the same: the link has
  // been answered, and a later comparison that has it must not jump to it.
  React.useEffect(() => {
    if (reveal === null) {
      return;
    }
    onRevealed();
    const index = files.findIndex((file) => file.path === reveal);
    const file = files[index];
    if (file === undefined) {
      return;
    }
    cursor.current = file.path;
    if (file.diff !== "") {
      updateReview((current) => withOpen(current, [file.path], true));
    }
    const scroller = scrollerRef.current;
    if (scroller !== null) {
      scrollToSection(scroller, scroller.children[index]);
    }
  }, [reveal, onRevealed, files, updateReview]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewSummary
        files={files}
        viewed={viewedCount(review, hashed)}
        allOpen={everyFileOpen(review, files, byDefault)}
        onAllOpenChange={(open) =>
          setOpen(
            files.filter((file) => file.diff !== "").map((file) => file.path),
            open,
          )
        }
      />
      <div
        ref={scrollerRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-border"
      >
        {hashed.map(({ file, hash }) => (
          <FileSection
            key={file.path}
            threadId={threadId}
            file={file}
            open={isOpen(review, file.path, byDefault)}
            onOpenChange={(open) => {
              cursor.current = file.path;
              setOpen([file.path], open);
            }}
            viewed={isViewed(review, file.path, hash)}
            onViewedChange={(viewed) =>
              updateReview((current) => withViewed(current, file.path, viewed ? hash : null))
            }
            diffStyle={diffStyle}
          />
        ))}
      </div>
    </div>
  );
}
