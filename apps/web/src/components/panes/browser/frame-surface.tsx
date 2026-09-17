/**
 * Mode B surface: renders the owned-Chromium JPEG stream and captures human
 * input over it. Every gesture is forwarded as a `browser.humanInput` — the
 * stream client replays it into Chromium via CDP, and the epoch bump is what
 * lets an in-flight `browser_*` call surface `interrupted_by_human`.
 *
 * Coordinates are scaled from the rendered box to the frame's device pixels.
 * Wheel events are throttled to ~60ms so a long scroll doesn't flood the
 * RPC stream; the remaining deltas accumulate instead of dropping.
 */
import * as React from "react";

import type { BrowserHumanInput, BrowserState } from "@OpenAde/contracts/rpc";

import { cn } from "@/lib/utils";

const WHEEL_THROTTLE_MS = 60;

const modifiersOf = (
  event: Pick<React.KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): Array<"alt" | "ctrl" | "meta" | "shift"> | undefined => {
  const modifiers = [
    event.altKey ? "alt" : null,
    event.ctrlKey ? "ctrl" : null,
    event.metaKey ? "meta" : null,
    event.shiftKey ? "shift" : null,
  ].filter((m): m is "alt" | "ctrl" | "meta" | "shift" => m !== null);
  return modifiers.length > 0 ? modifiers : undefined;
};

export interface FrameSurfaceProps {
  readonly state: BrowserState;
  readonly onGesture: (input: BrowserHumanInput) => void;
}

export function FrameSurface({ state, onGesture }: FrameSurfaceProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const wheelPending = React.useRef({ x: 0, y: 0, timer: 0 as number | 0 });

  React.useEffect(
    () => () => {
      if (wheelPending.current.timer !== 0) {
        window.clearTimeout(wheelPending.current.timer);
      }
    },
    [],
  );

  const toDevice = (event: React.MouseEvent): { x: number; y: number } | null => {
    const box = containerRef.current;
    const frame = state.frame;
    if (box === null || frame === null) return null;
    const rect = box.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const drawnW = frame.width * scale;
    const drawnH = frame.height * scale;
    const offsetX = (rect.width - drawnW) / 2;
    const offsetY = (rect.height - drawnH) / 2;
    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;
    return x < 0 || y < 0 || x > frame.width || y > frame.height
      ? null
      : { x: Math.round(x), y: Math.round(y) };
  };

  const onMouseDown = (event: React.MouseEvent) => {
    const point = toDevice(event);
    if (point === null) return;
    event.preventDefault();
    containerRef.current?.focus();
    onGesture({
      kind: "click",
      x: point.x,
      y: point.y,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    });
  };

  const onWheel = (event: React.WheelEvent) => {
    const pending = wheelPending.current;
    pending.x += event.deltaX;
    pending.y += event.deltaY;
    if (pending.timer === 0) {
      pending.timer = window.setTimeout(() => {
        const { x, y } = wheelPending.current;
        wheelPending.current = { x: 0, y: 0, timer: 0 };
        if (x !== 0 || y !== 0) {
          onGesture({ kind: "scroll", deltaX: Math.round(x), deltaY: Math.round(y) });
        }
      }, WHEEL_THROTTLE_MS);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Tab") return; // keep pane focus order sane
    event.preventDefault();
    const modifiers = modifiersOf(event);
    onGesture({ kind: "key", key: event.key, ...(modifiers !== undefined && { modifiers }) });
  };

  const frame = state.frame;

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Browser preview"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        "relative flex flex-1 items-center justify-center overflow-hidden bg-black/90",
        "outline-none select-none",
      )}
    >
      {frame === null ? (
        <div className="text-muted-foreground text-sm">
          {state.status === "ready" ? "waiting for first frame…" : (state.message ?? "starting…")}
        </div>
      ) : (
        <img
          src={`data:${frame.mediaType};base64,${frame.base64}`}
          alt={state.title ?? state.url ?? "browser page"}
          draggable={false}
          className="pointer-events-none max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}
