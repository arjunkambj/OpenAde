/**
 * What the drawer's toolbar may do with the xterm in front, handed up by
 * `./terminal-view` while it is mounted. A plain interface, so the drawer can
 * hold one without importing xterm, which only the lazy view chunk loads.
 */

export interface TerminalHandle {
  /** The selected text, as the grid draws it — lines padded with spaces. */
  readonly selection: () => string;
  readonly clearSelection: () => void;
  /**
   * Calls `listener` with whether anything is selected, at once and after
   * every change. Returns the unsubscribe.
   */
  readonly watchSelection: (listener: (selected: boolean) => void) => () => void;
}
