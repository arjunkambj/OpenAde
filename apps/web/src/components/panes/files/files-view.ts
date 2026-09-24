/**
 * Where each thread's Files tab was left: the search, the open file and the
 * page it was on, and how far each list was scrolled.
 *
 * The dock unmounts a tab it is not showing (keeping every pane mounted and
 * hidden would keep every pane's reads live), so this used to be component
 * state and a trip to Changes and back cleared the search and closed the file.
 * It lives in an atom keyed by thread instead, the way the composer's draft
 * does, in memory only: a relaunch starts every Files tab blank.
 *
 * Scroll offsets are written when the pane unmounts, not on every scroll
 * event — a write per frame would re-render the pane while it scrolls — and
 * read back as each scrolling element mounts (`useKeptScroll`).
 *
 * A file chip in the timeline opens a file here too (`useRevealFile`, called
 * by the thread view as it opens the dock on Files): the preview starts on
 * the page that shows the chip's line, marks it, and scrolls to it once.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import type { FileRevealTarget } from "@/state/file-reveal";

import { offsetForLine } from "./preview";

/** The open file, and where in it the reader was. */
export interface FilesPreviewView {
  readonly path: string;
  /** The line offset of the page shown (`FilePreview`'s own paging). */
  readonly offset: number;
  /** The offsets Next came from, so Previous walks back over them. */
  readonly visited: ReadonlyArray<number>;
  readonly scroll: number;
  /** The 1-based line a file chip opened the file at, marked in the preview. */
  readonly line?: number;
  /** Set until the preview has scrolled to `line` (or its top) once. */
  readonly reveal?: boolean;
}

export interface FilesView {
  readonly query: string;
  readonly listScroll: number;
  readonly preview: FilesPreviewView | null;
}

export const emptyFilesView: FilesView = { query: "", listScroll: 0, preview: null };

/** A preview of `path` from its first page. */
export const openedPreview = (path: string): FilesPreviewView => ({
  path,
  offset: 0,
  visited: [],
  scroll: 0,
});

/** A preview of a file chip's file, on the page that shows its line. */
export const revealedPreview = (target: FileRevealTarget): FilesPreviewView => ({
  path: target.path,
  offset: offsetForLine(target.line),
  visited: [],
  scroll: 0,
  ...(target.line === undefined ? {} : { line: target.line }),
  reveal: true,
});

const isEmptyView = (view: FilesView): boolean =>
  view.query === "" && view.listScroll === 0 && view.preview === null;

/** The map with one thread's view replaced; a blank view drops its key. */
export const withFilesView = (
  views: Readonly<Record<string, FilesView>>,
  threadId: string,
  view: FilesView,
): Readonly<Record<string, FilesView>> => {
  if (views[threadId] === view) {
    return views;
  }
  if (isEmptyView(view)) {
    if (!(threadId in views)) {
      return views;
    }
    const next = { ...views };
    delete next[threadId];
    return next;
  }
  return { ...views, [threadId]: view };
};

// `keepAlive`: the Files pane is this atom's only reader, and the point is to
// outlive that pane's unmount.
const filesViewAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, FilesView>>>({}));

/** One thread's Files view, and an updater that maps it to the next one. */
export const useFilesView = (threadId: string) => {
  const view = useAtomValue(
    filesViewAtom,
    React.useCallback(
      (views: Readonly<Record<string, FilesView>>) => views[threadId] ?? emptyFilesView,
      [threadId],
    ),
  );
  const setViews = useAtomSet(filesViewAtom);
  const update = React.useCallback(
    (change: (current: FilesView) => FilesView) =>
      setViews((views) =>
        withFilesView(views, threadId, change(views[threadId] ?? emptyFilesView)),
      ),
    [setViews, threadId],
  );
  return [view, update] as const;
};

/**
 * A scroll position kept in `offset` (a ref the caller saves when it leaves):
 * `ref` puts it back on whichever element mounts, and `onScroll` tracks it.
 */
export const useKeptScroll = (offset: React.RefObject<number>) => {
  const ref = React.useCallback(
    (element: HTMLElement | null) => {
      if (element !== null) {
        element.scrollTop = offset.current;
      }
    },
    [offset],
  );
  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLElement>) => {
      offset.current = event.currentTarget.scrollTop;
    },
    [offset],
  );
  return { ref, onScroll };
};

/**
 * Opens a file in a thread's Files view at a line, replacing whatever file it
 * showed and keeping its search. It only writes the view: the caller opens
 * the dock on Files.
 */
export const useRevealFile = (threadId: string) => {
  const setViews = useAtomSet(filesViewAtom);
  return React.useCallback(
    (target: FileRevealTarget) =>
      setViews((views) =>
        withFilesView(views, threadId, {
          ...(views[threadId] ?? emptyFilesView),
          preview: revealedPreview(target),
        }),
      ),
    [setViews, threadId],
  );
};
