/**
 * Requests to open a file in a thread's Files tab — presentation state, in
 * memory only, the way `browser-activity.ts` asks for the browser pane.
 *
 * A file chip in the timeline asks with `useRequestFileReveal`; the thread
 * view answers with `useFileRevealRequests`, which opens the dock on Files at
 * that file and line and clears the request, now or when the thread is next
 * on screen. One pending request per thread: a second click before the first
 * is answered replaces it.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** A workspace file to show, and the 1-based line to show it at. */
export interface FileRevealTarget {
  /** Relative to the thread's workspace root, as `files.read` takes it. */
  readonly path: string;
  readonly line?: number;
}

type Requests = Readonly<Record<string, FileRevealTarget>>;

// `keepAlive`: the request is written by a row and read by the thread view,
// and has to outlive the moment between the two.
const fileRevealRequestsAtom = Atom.keepAlive(Atom.make<Requests>({}));

/** A function that asks for a file to be shown in a thread's Files tab. */
export const useRequestFileReveal = () => {
  const setRequests = useAtomSet(fileRevealRequestsAtom);
  return React.useCallback(
    (threadId: string, target: FileRevealTarget) =>
      setRequests((current) => ({ ...current, [threadId]: target })),
    [setRequests],
  );
};

/** Calls `reveal` whenever the thread has a request pending, and clears it. */
export const useFileRevealRequests = (
  threadId: string,
  reveal: (target: FileRevealTarget) => void,
) => {
  const pending = useAtomValue(
    fileRevealRequestsAtom,
    React.useCallback((requests: Requests) => requests[threadId], [threadId]),
  );
  const setRequests = useAtomSet(fileRevealRequestsAtom);
  React.useEffect(() => {
    if (pending === undefined) return;
    setRequests((current) => {
      const { [threadId]: _answered, ...rest } = current;
      return rest;
    });
    reveal(pending);
  }, [pending, reveal, setRequests, threadId]);
};
