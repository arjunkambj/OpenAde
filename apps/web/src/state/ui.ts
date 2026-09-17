/**
 * UI-only atoms — presentation state that never reaches the server.
 *
 * Row disclosure lives in a single override map keyed by itemId so expanding a
 * tool row survives virtualization (the row unmounts, the state does not).
 * Dock width persists through localStorage — durable layout, nothing more.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

/** Per-row disclosure overrides: `itemId -> open`. Absent = the row's default. */
const rowDisclosureAtom = Atom.make<Readonly<Record<string, boolean>>>({});

/**
 * `[open, setOpen]` for one disclosure, where `defaultOpen` covers rows that
 * start expanded (plan cards) against the collapsed default. `setOpen` takes
 * the explicit next state so it can be handed to `Collapsible.onOpenChange`.
 */
export const useRowDisclosure = (rowId: string, defaultOpen = false) => {
  const isOpen = useAtomValue(
    rowDisclosureAtom,
    React.useCallback((overrides) => overrides[rowId] ?? defaultOpen, [rowId, defaultOpen]),
  );
  const setOverrides = useAtomSet(rowDisclosureAtom);
  const setOpen = React.useCallback(
    (open: boolean) => setOverrides((overrides) => ({ ...overrides, [rowId]: open })),
    [setOverrides, rowId],
  );
  return [isOpen, setOpen] as const;
};

const DOCK_WIDTH_KEY = "openade:dock-width";
const DOCK_WIDTH_DEFAULT = 380;
const DOCK_WIDTH_MIN = 280;
const DOCK_WIDTH_MAX = 720;

const readDockWidth = (): number => {
  try {
    const stored = globalThis.localStorage?.getItem(DOCK_WIDTH_KEY);
    if (stored === null || stored === undefined) {
      return DOCK_WIDTH_DEFAULT;
    }
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed)
      ? Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, parsed))
      : DOCK_WIDTH_DEFAULT;
  } catch {
    return DOCK_WIDTH_DEFAULT;
  }
};

/** Right-dock width in px; mirrored to localStorage on every write. */
const dockWidthAtom = Atom.make<number>(readDockWidth());

export const useDockWidth = () => {
  const width = useAtomValue(dockWidthAtom);
  const setWidth = useAtomSet(dockWidthAtom);
  const setPersistedWidth = React.useCallback(
    (next: number) => {
      const clamped = Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, Math.round(next)));
      try {
        globalThis.localStorage?.setItem(DOCK_WIDTH_KEY, String(clamped));
      } catch {
        // localStorage can throw (private mode, quota); the atom still updates.
      }
      setWidth(clamped);
    },
    [setWidth],
  );
  return [width, setPersistedWidth] as const;
};
