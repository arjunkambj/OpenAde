/**
 * The agent's cursor over a pane tab: where the agent last moved its pointer,
 * with a pulse where it pressed, so a person watching the pane can see what
 * the agent is about to click.
 *
 * The shell relays the agent's native mouse input
 * (`window.poseidon.browserPane.onAgentPointer`); each tab keeps its latest
 * point, which fades after a short idle. It is drawn only over the tab on
 * screen, never takes a click, and sits just above the webview.
 */
import * as React from "react";

import { CursorClick } from "@honeyicons/react";

import type { Rect } from "./host-geometry";
import { pointerOnPane } from "./pointer-transform";

type PaneBridge = NonNullable<NonNullable<Window["poseidon"]>["browserPane"]>;

/** How long the cursor stays after the agent's last move or press. */
const IDLE_MS = 2500;

export interface AgentPointerMark {
  readonly x: number;
  readonly y: number;
  /** Bumps on every press, so the pulse restarts. */
  readonly presses: number;
  readonly pressed: boolean;
}

/** The latest agent pointer per tab, by the guest's `webContents` id. */
export const useAgentPointers = (bridge: PaneBridge): ReadonlyMap<number, AgentPointerMark> => {
  const [marks, setMarks] = React.useState<ReadonlyMap<number, AgentPointerMark>>(new Map());

  React.useEffect(() => {
    if (bridge.onAgentPointer === undefined) return;
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const stop = bridge.onAgentPointer(({ wcId, x, y, kind }) => {
      setMarks((current) => {
        const next = new Map(current);
        const presses = (current.get(wcId)?.presses ?? 0) + (kind === "press" ? 1 : 0);
        next.set(wcId, { x, y, presses, pressed: kind === "press" });
        return next;
      });
      clearTimeout(timers.get(wcId));
      timers.set(
        wcId,
        setTimeout(() => {
          timers.delete(wcId);
          setMarks((current) => {
            const next = new Map(current);
            next.delete(wcId);
            return next;
          });
        }, IDLE_MS),
      );
    });
    return () => {
      stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [bridge]);

  return marks;
};

export function AgentCursor({
  mark,
  box,
  zoomLevel,
}: {
  readonly mark: AgentPointerMark;
  readonly box: Rect;
  readonly zoomLevel: number;
}) {
  const at = pointerOnPane(mark, box, zoomLevel);
  if (at === null) return null;
  return (
    <div
      aria-hidden
      data-agent-cursor=""
      className="pointer-events-none fixed top-(--agent-cursor-y) left-(--agent-cursor-x) z-40"
      style={
        {
          "--agent-cursor-x": `${at.x}px`,
          "--agent-cursor-y": `${at.y}px`,
        } as React.CSSProperties
      }
    >
      {mark.pressed ? (
        <span
          key={mark.presses}
          className="absolute -top-3 -left-3 size-6 animate-ping rounded-full bg-primary/40"
        />
      ) : null}
      <CursorClick variant="bold" className="size-5 text-primary drop-shadow-sm" />
    </div>
  );
}
