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
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** The open file, and where in it the reader was. */
export interface FilesPreviewView {
  readonly path: string;
  /** The line offset of the page shown (`FilePreview`'s own paging). */
  readonly offset: number;
  /** The offsets Next came from, so Previous walks back over them. */
  readonly visited: ReadonlyArray<number>;
  readonly scroll: number;
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
