/**
 * Keeps a panel mounted through its open and close transitions.
 *
 * A panel that shows and hides by mounting cannot animate its way out: it is
 * gone the render it closes. `usePresence` answers where the panel is in its
 * life — `entering` for the transition in, `shown` once it has settled,
 * `leaving` while it transitions out, and null once it is gone — so the
 * panel can stay on screen for its exit and apply its transition classes only
 * while it moves. A settled panel has none, so dragging its edge to resize
 * it still tracks the pointer rather than easing after it.
 *
 * A panel already open on the first render starts `shown`: a reload that
 * lands with the dock open should not play it in.
 */

import * as React from "react";

/** How long the panels take to open or close; `duration-200` in their classes. */
const PRESENCE_MS = 200;

export type Presence = "entering" | "shown" | "leaving";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function usePresence(open: boolean): Presence | null {
  const [phase, setPhase] = React.useState<Presence | null>(open ? "shown" : null);
  const [wasOpen, setWasOpen] = React.useState(open);
  let current = phase;
  if (open !== wasOpen) {
    // Settle the change in this render, so the panel mounts (or starts
    // leaving) on the same paint the open state flips.
    current = open ? "entering" : phase === null ? null : "leaving";
    setWasOpen(open);
    setPhase(current);
  }

  React.useEffect(() => {
    if (phase !== "entering" && phase !== "leaving") {
      return;
    }
    const timer = window.setTimeout(
      () => setPhase(phase === "entering" ? "shown" : null),
      prefersReducedMotion() ? 0 : PRESENCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  return current;
}
