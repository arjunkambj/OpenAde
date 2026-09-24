/**
 * Where the address bar's suggestions come from: the thread's project's dev
 * servers (`browser.discoverServers`, fetched while the bar is on screen and
 * again each time its list opens) and the project's history.
 */
import * as React from "react";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { DevServer } from "@poseidon/contracts/rpc";
import { AsyncResult } from "effect/unstable/reactivity";

import { useBrowserHistory } from "@/state/browser-history";
import { useBrowserAtoms } from "./browser-atoms";
import type { HistoryEntry } from "./history";

export interface SuggestionSource {
  readonly servers: ReadonlyArray<DevServer>;
  readonly history: ReadonlyArray<HistoryEntry>;
  /** Asks the server again; it answers from its short cache when it can. */
  readonly refresh: () => void;
}

const NONE: ReadonlyArray<DevServer> = [];

/** The thread's running dev servers, and a way to ask again. */
const useDevServers = (threadId: ThreadId) => {
  const atom = useBrowserAtoms().devServersAtom(threadId);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  return { servers: AsyncResult.isSuccess(result) ? result.value : NONE, refresh };
};

export const useSuggestionSource = (
  threadId: ThreadId,
  projectId: string | null,
): SuggestionSource => {
  const { servers, refresh } = useDevServers(threadId);
  const history = useBrowserHistory(projectId);
  return React.useMemo(() => ({ servers, history, refresh }), [servers, history, refresh]);
};
