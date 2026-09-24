/**
 * The thread's terminal drawer, at the bottom of the thread column.
 *
 * `ThreadTerminal` is always mounted with the thread view: it answers
 * `terminal.toggle` and renders the drawer only while this thread's drawer is
 * open (`@/state/terminal-ui`). The drawer holds a tab strip over a lazily
 * loaded xterm (`./terminal-view`) for the tab in front, a fresh one per tab,
 * and a toolbar that acts on that xterm — "Add selection to chat" quotes its
 * selection into the thread's composer draft, and Find (`./terminal-find`)
 * searches the xterm's output. A mod-clicked link opens in the
 * thread's browser pane (`./use-open-link`).
 *
 * Which terminals exist is the server's to say: the drawer folds each
 * `terminal.list` into its tab state (`./drawer-state`). Opening a drawer that
 * has none starts one, at the grid the xterm measured, and closing the last
 * tab hides the drawer — an open drawer with nothing in it has no use.
 *
 * The root carries `data-context="terminal"`, which is what makes the app's
 * keybinding listener leave every chord but the toggle to the shell.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { makeTerminalId, type TerminalId, type ThreadId } from "@OpenAde/contracts/ids";
import { TERMINALS_PER_THREAD, type TerminalSize } from "@OpenAde/contracts/terminal";
import { Button } from "@OpenAde/ui/components/button";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { AddSelectionButton } from "@/components/terminal/add-selection-button";
import { DrawerMessage, IconButton, TerminalTabButton } from "@/components/terminal/drawer-parts";
import { nextTitle, useDrawerState } from "@/components/terminal/drawer-state";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { TerminalFind } from "@/components/terminal/terminal-find";
import type { TerminalHandle } from "@/components/terminal/terminal-handle";
import { useOpenInBrowserPane } from "@/components/terminal/use-open-link";
import { describeExitError } from "@/lib/app-runtime";
import { SHORTCUT_COMMANDS, ShortcutKbd, useKeybindingCommand } from "@/lib/shortcuts";
import { useConnectionState } from "@/state/hooks";
import {
  DRAWER_HEIGHT_MAX_FRACTION,
  DRAWER_HEIGHT_MIN,
  useDrawerHeight,
  useTerminalOpen,
} from "@/state/terminal-ui";
import { Add, ChevronDown, Search, Spinner } from "@honeyicons/react";

const TerminalView = React.lazy(() => import("@/components/terminal/terminal-view"));

/** Drag the top edge to resize; the height atom persists every frame. */
function useDrawerResize() {
  const [height, setHeight] = useDrawerHeight();
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const drawer = event.currentTarget.parentElement;
      const startHeight = drawer?.getBoundingClientRect().height ?? height;
      const column = drawer?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
      const onMove = (move: PointerEvent) => {
        // The drawer sits at the bottom: dragging up makes it taller.
        setHeight(startHeight + (startY - move.clientY), column);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [height, setHeight],
  );
  return { height, onPointerDown };
}

function TerminalDrawer({
  threadId,
  focusRequest,
  onHide,
  onClose,
  onOpenLink,
}: {
  threadId: ThreadId;
  focusRequest: number;
  onHide: () => void;
  onClose: (terminalId: TerminalId) => void;
  onOpenLink: (url: string) => void;
}) {
  const atoms = useTerminalAtoms();
  const connected = useConnectionState().status === "connected";
  const list = useAtomValue(atoms.terminalListAtom(threadId));
  const openTerminal = useAtomSet(atoms.openTerminal, { mode: "promiseExit" });
  const [state, dispatch] = useDrawerState(threadId);
  const { height, onPointerDown } = useDrawerResize();

  const [opening, setOpening] = React.useState(false);
  const [openError, setOpenError] = React.useState<string | null>(null);
  const [measured, setMeasured] = React.useState(false);
  const [handle, setHandle] = React.useState<TerminalHandle | null>(null);
  const [finding, setFinding] = React.useState(false);
  const [tabFocus, bumpTabFocus] = React.useReducer((count: number) => count + 1, 0);
  const gridRef = React.useRef<TerminalSize | null>(null);
  const tabsRef = React.useRef(state.tabs);
  tabsRef.current = state.tabs;

  const listed = AsyncResult.isSuccess(list) ? list.value : null;
  React.useEffect(() => {
    if (listed?._tag === "ok") {
      dispatch({ type: "synced", terminals: listed.terminals });
    }
  }, [listed, dispatch]);

  const openNew = React.useCallback(async () => {
    const size = gridRef.current ?? { cols: 80, rows: 24 };
    setOpening(true);
    setOpenError(null);
    const exit = await openTerminal({
      threadId,
      terminalId: makeTerminalId(),
      title: nextTitle(tabsRef.current),
      ...size,
    });
    setOpening(false);
    if (exit._tag === "Success") {
      dispatch({ type: "opened", terminal: exit.value });
      bumpTabFocus();
    } else {
      setOpenError(describeExitError(exit, "Could not open a terminal."));
    }
  }, [dispatch, openTerminal, threadId]);

  // An open drawer with no terminals starts one — once the listing has said
  // there are none, and once the xterm has measured the grid to start it at.
  // A failed open waits for the user rather than retrying on its own.
  const listedNone = listed?._tag === "ok" && listed.terminals.length === 0;
  React.useEffect(() => {
    if (
      connected &&
      listedNone &&
      measured &&
      state.tabs.length === 0 &&
      !opening &&
      openError === null
    ) {
      void openNew();
    }
  }, [connected, listedNone, measured, state.tabs.length, opening, openError, openNew]);

  const onGrid = React.useCallback((size: TerminalSize) => {
    gridRef.current = size;
    setMeasured(true);
  }, []);
  const onExited = React.useCallback(
    (terminalId: TerminalId, exitCode: number | null) =>
      dispatch({ type: "exited", terminalId, exitCode }),
    [dispatch],
  );
  const onGone = React.useCallback(
    (terminalId: TerminalId) => dispatch({ type: "closed", terminalId }),
    [dispatch],
  );

  const close = (terminalId: TerminalId) => {
    const last = state.tabs.length === 1 && state.tabs[0]?.terminalId === terminalId;
    dispatch({ type: "closed", terminalId });
    onClose(terminalId);
    if (last) {
      onHide();
    } else {
      bumpTabFocus();
    }
  };

  const closeFind = () => {
    setFinding(false);
    handle?.focus();
  };

  const full = state.tabs.length >= TERMINALS_PER_THREAD;
  const listError = listed?._tag === "error" ? listed.message : null;

  let body: React.ReactNode;
  if (!connected) {
    body = <DrawerMessage title="Not connected to a server" />;
  } else if (listError !== null && state.tabs.length === 0) {
    body = <DrawerMessage title="Could not list terminals" message={listError} />;
  } else if (openError !== null && state.tabs.length === 0) {
    body = (
      <DrawerMessage
        title="Could not open a terminal"
        message={openError}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void openNew()}>
            Try again
          </Button>
        }
      />
    );
  } else {
    body = (
      <React.Suspense
        fallback={
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Spinner variant="bold" className="size-4" />
          </div>
        }
      >
        <TerminalView
          key={state.activeId ?? "unattached"}
          threadId={threadId}
          terminalId={state.activeId}
          focusRequest={focusRequest + tabFocus}
          onGrid={onGrid}
          onExited={onExited}
          onGone={onGone}
          onHandle={setHandle}
          onOpenLink={onOpenLink}
        />
      </React.Suspense>
    );
  }

  return (
    <div
      data-context="terminal"
      aria-label="Terminal"
      role="region"
      // Not `shrink-0`: the header and composer above cannot shrink, so on a
      // short window the drawer gives up height, down to its minimum, rather
      // than push its own bottom rows — the prompt — out of the column.
      className="relative flex h-(--terminal-height) min-h-(--terminal-min-height) flex-col border-t border-border bg-background"
      style={
        {
          "--terminal-height": `min(${height}px, ${DRAWER_HEIGHT_MAX_FRACTION * 100}%)`,
          "--terminal-min-height": `${DRAWER_HEIGHT_MIN}px`,
        } as React.CSSProperties
      }
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        onPointerDown={onPointerDown}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {state.tabs.map((tab) => (
            <TerminalTabButton
              key={tab.terminalId}
              tab={tab}
              active={tab.terminalId === state.activeId}
              onSelect={() => {
                dispatch({ type: "activated", terminalId: tab.terminalId });
                bumpTabFocus();
              }}
              onClose={() => close(tab.terminalId)}
            />
          ))}
          {opening ? (
            <Spinner variant="bold" className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </div>
        {openError !== null && state.tabs.length > 0 ? (
          <p className="min-w-0 shrink truncate type-micro text-destructive">{openError}</p>
        ) : null}
        <IconButton
          label="Find"
          disabled={handle === null}
          onClick={() => (finding ? closeFind() : setFinding(true))}
        >
          <Search variant="bold" />
        </IconButton>
        <AddSelectionButton threadId={threadId} handle={handle} />
        <IconButton
          label={full ? `At most ${TERMINALS_PER_THREAD} terminals per thread` : "New terminal"}
          disabled={!connected || opening || full}
          onClick={() => void openNew()}
        >
          <Add variant="bold" />
        </IconButton>
        <IconButton label="Hide terminal" onClick={onHide} hint={<ShortcutKbd id="terminal" />}>
          <ChevronDown variant="bold" />
        </IconButton>
      </div>
      {finding && handle !== null ? (
        <div className="flex shrink-0 justify-end px-2 pb-1">
          <TerminalFind handle={handle} onClose={closeFind} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 px-2 pb-1">{body}</div>
    </div>
  );
}

/**
 * Answers `terminal.toggle` for the thread on screen and shows its drawer
 * while open. Mount it keyed by threadId, so each thread starts with its own
 * drawer rather than inheriting the last one's xterm. `onShowBrowser` puts the
 * dock on its Browser tab, for a link the terminal opens there.
 */
export function ThreadTerminal({
  threadId,
  onShowBrowser,
}: {
  threadId: ThreadId;
  onShowBrowser: () => void;
}) {
  const [open, setOpen] = useTerminalOpen(threadId);
  const openLink = useOpenInBrowserPane(threadId, onShowBrowser);
  const [focusRequest, bumpFocus] = React.useReducer((count: number) => count + 1, 0);
  // Mounted here, not in the drawer: closing the last tab hides the drawer,
  // and the close must not be cut short by the drawer unmounting.
  const closeTerminal = useAtomSet(useTerminalAtoms().closeTerminal);

  useKeybindingCommand(SHORTCUT_COMMANDS.terminal, () => {
    if (!open) {
      bumpFocus();
    }
    setOpen(!open);
  });

  if (!open) {
    return null;
  }
  return (
    <TerminalDrawer
      threadId={threadId}
      focusRequest={focusRequest}
      onHide={() => setOpen(false)}
      onClose={(terminalId) => closeTerminal({ threadId, terminalId })}
      onOpenLink={openLink}
    />
  );
}
