/**
 * What the drawer's toolbar may do with the xterm in front, handed up by
 * `./terminal-view` while it is mounted. A plain interface, so the drawer can
 * hold one without importing xterm, which only the lazy view chunk loads.
 */

/** Where find stands: the current match (-1 past the highlight limit) of `count`. */
export interface FindResults {
  readonly index: number;
  readonly count: number;
}

export interface TerminalHandle {
  /** The selected text, as the grid draws it — lines padded with spaces. */
  readonly selection: () => string;
  readonly clearSelection: () => void;
  /**
   * Calls `listener` with whether anything is selected, at once and after
   * every change. Returns the unsubscribe.
   */
  readonly watchSelection: (listener: (selected: boolean) => void) => () => void;
  /**
   * Selects the next or previous match of `query` and highlights the rest.
   * `incremental` keeps the current match while it still matches, for
   * searching as the user types. False when nothing matches.
   */
  readonly find: (query: string, direction: "next" | "previous", incremental?: boolean) => boolean;
  /** Calls `listener` whenever the matches change. Returns the unsubscribe. */
  readonly watchFindResults: (listener: (results: FindResults) => void) => () => void;
  /** Removes find's highlights; the current match stays selected. */
  readonly clearFind: () => void;
  readonly focus: () => void;
}
