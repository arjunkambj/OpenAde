/**
 * The xterm that shows the drawer's active terminal. Loaded lazily by the
 * drawer, so a thread view that never opens a terminal never pays for xterm.
 *
 * One xterm serves whichever tab is in front: switching tabs re-attaches it to
 * the other terminal, whose first stream item is a `snapshot` the xterm is
 * reset to. With no terminal yet (`terminalId` null) it only measures, so the
 * drawer can open the first shell at the size it will be shown at.
 *
 * Unmounting disposes the xterm and ends the subscription; the shell keeps
 * running on the server, and the next mount reattaches from the snapshot.
 *
 * Keys: the chord bound to `terminal.toggle` is refused to xterm through
 * `attachCustomKeyEventHandler`, so it bubbles to the app's one keybinding
 * listener instead of reaching the shell (off macOS, `Ctrl+J` would otherwise
 * be a line feed). Every other key is the shell's; see `@/lib/shortcuts`.
 */

import "@xterm/xterm/css/xterm.css";

import { useAtomSet } from "@effect/atom-react";
import { detectModKey, resolveKeybinding } from "@OpenAde/client-runtime/keybindings";
import { encodeTerminalKey, type TerminalAttachItem } from "@OpenAde/client-runtime/terminalAtoms";
import type { TerminalId, ThreadId } from "@OpenAde/contracts/ids";
import type { TerminalSize } from "@OpenAde/contracts/terminal";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import { useTheme } from "@/components/theme-provider";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { readTerminalTheme } from "@/components/terminal/terminal-theme";
import { TERMINAL_TOGGLE_COMMAND } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/shortcuts";

/** How long a run of grid changes settles before the new size is sent. */
const RESIZE_DEBOUNCE_MS = 100;

/** A grid inside the bounds `TerminalSize` accepts. */
const boundedSize = (cols: number, rows: number): TerminalSize => ({
  cols: Math.max(2, Math.min(1000, cols)),
  rows: Math.max(1, Math.min(500, rows)),
});

const exitLine = (exitCode: number | null, signal: number | null): string =>
  exitCode !== null
    ? `[process exited with code ${exitCode}]`
    : signal !== null
      ? `[process ended by signal ${signal}]`
      : "[process exited]";

interface Xterm {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
}

/**
 * A counter that moves whenever the app's look may have changed: the resolved
 * theme, or the root element's class or inline style — where the theme class
 * and the Appearance font scales are applied, and which catches a change
 * `useTheme` does not report.
 */
function useLookVersion(): string {
  const { resolvedTheme } = useTheme();
  const [mutations, bump] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    const observer = new MutationObserver(() => bump());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return `${resolvedTheme ?? ""}:${mutations}`;
}

function TerminalAttachment({
  threadId,
  terminalId,
  terminal,
  onExited,
  onGone,
}: {
  threadId: ThreadId;
  terminalId: TerminalId;
  terminal: Terminal;
  onExited: (terminalId: TerminalId, exitCode: number | null) => void;
  onGone: (terminalId: TerminalId) => void;
}) {
  const atoms = useTerminalAtoms();
  const setAttach = useAtomSet(
    atoms.terminalAttachAtom(encodeTerminalKey({ threadId, terminalId })),
  );
  const write = useAtomSet(atoms.writeTerminal);
  const resize = useAtomSet(atoms.resizeTerminal);
  const handlersRef = React.useRef({ onExited, onGone });
  handlersRef.current = { onExited, onGone };

  React.useEffect(() => {
    const ref = { threadId, terminalId };
    let live = true;
    // Output is kept only past this offset; the snapshot sets it.
    let offset = -1;
    // Snapshots still being parsed. A replay carries the shell's old queries —
    // cursor position, device attributes, background colour — and xterm
    // answers each one as input; those answers belong to a prompt long gone,
    // so input is held back until the replay has been parsed.
    let replaying = 0;
    let sent: TerminalSize | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sendSize = () => {
      const size = boundedSize(terminal.cols, terminal.rows);
      if (sent?.cols === size.cols && sent.rows === size.rows) {
        return;
      }
      sent = size;
      resize({ ...ref, ...size });
    };

    const onItem = (item: TerminalAttachItem) => {
      if (!live) {
        return;
      }
      switch (item.kind) {
        case "snapshot":
          terminal.reset();
          replaying += 1;
          terminal.write(item.data, () => {
            replaying -= 1;
          });
          offset = item.offset;
          sent = { cols: item.terminal.cols, rows: item.terminal.rows };
          sendSize();
          return;
        case "output":
          if (item.offset <= offset) {
            return;
          }
          terminal.write(item.data);
          offset = item.offset;
          return;
        case "exited":
          terminal.write(`\r\n${exitLine(item.exitCode, item.signal)}\r\n`);
          handlersRef.current.onExited(terminalId, item.exitCode);
          return;
        case "resnapshot-required":
          // The attach loop subscribes again; its snapshot resets the view.
          return;
        case "gone":
          handlersRef.current.onGone(terminalId);
          return;
      }
    };

    // A fn atom's value is its argument, and a function would be taken for an
    // updater, so the callback goes in wrapped.
    setAttach(() => onItem);
    const input = terminal.onData((data) => {
      if (replaying === 0) {
        write({ ...ref, data });
      }
    });
    const grid = terminal.onResize(() => {
      clearTimeout(timer);
      timer = setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      input.dispose();
      grid.dispose();
      setAttach(Atom.Reset);
    };
  }, [threadId, terminalId, terminal, setAttach, write, resize]);

  return null;
}

export default function TerminalView({
  threadId,
  terminalId,
  focusRequest,
  onGrid,
  onExited,
  onGone,
}: {
  threadId: ThreadId;
  terminalId: TerminalId | null;
  /** Focus the terminal whenever this changes; 0 means "not asked yet". */
  focusRequest: number;
  /** The grid after every fit, so the drawer can open a shell at that size. */
  onGrid: (size: TerminalSize) => void;
  onExited: (terminalId: TerminalId, exitCode: number | null) => void;
  onGone: (terminalId: TerminalId) => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [xterm, setXterm] = React.useState<Xterm | null>(null);
  const look = useLookVersion();

  const keybindings = useKeybindings();
  const toggleBindingsRef = React.useRef(keybindings);
  toggleBindingsRef.current = keybindings.filter(
    (binding) => binding.command === TERMINAL_TOGGLE_COMMAND,
  );
  const onGridRef = React.useRef(onGrid);
  onGridRef.current = onGrid;

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const { theme, fontFamily } = readTerminalTheme(host);
    const terminal = new Terminal({
      theme,
      fontFamily,
      fontSize: Number.parseFloat(getComputedStyle(host).fontSize) || 12,
      scrollback: 5000,
      macOptionIsMeta: false,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.loadAddon(new SearchAddon());

    const modKey = detectModKey();
    const inTerminal = (name: string) =>
      name === "terminalFocus" ? true : name === "composerFocus" ? false : undefined;
    terminal.attachCustomKeyEventHandler(
      (event) => resolveKeybinding(toggleBindingsRef.current, event, inTerminal, modKey) === null,
    );

    terminal.open(host);
    const refit = () => {
      fit.fit();
      onGridRef.current(boundedSize(terminal.cols, terminal.rows));
    };
    refit();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    observer.observe(host);
    setXterm({ terminal, fit });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      setXterm(null);
      terminal.dispose();
    };
  }, []);

  // Re-read the tokens when the theme or the font scale changes.
  React.useEffect(() => {
    const host = hostRef.current;
    if (xterm === null || host === null) {
      return;
    }
    const { theme, fontFamily } = readTerminalTheme(host);
    xterm.terminal.options.theme = theme;
    xterm.terminal.options.fontFamily = fontFamily;
    xterm.terminal.options.fontSize = Number.parseFloat(getComputedStyle(host).fontSize) || 12;
    xterm.fit.fit();
    onGridRef.current(boundedSize(xterm.terminal.cols, xterm.terminal.rows));
  }, [xterm, look]);

  React.useEffect(() => {
    if (xterm !== null && focusRequest > 0) {
      xterm.terminal.focus();
    }
  }, [xterm, focusRequest, terminalId]);

  return (
    <>
      <div ref={hostRef} className="size-full overflow-hidden font-mono text-xs" />
      {xterm !== null && terminalId !== null ? (
        <TerminalAttachment
          key={terminalId}
          threadId={threadId}
          terminalId={terminalId}
          terminal={xterm.terminal}
          onExited={onExited}
          onGone={onGone}
        />
      ) : null}
    </>
  );
}
