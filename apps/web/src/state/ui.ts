/**
 * UI-only atoms — presentation state that never reaches the server.
 *
 * Row disclosure lives in a single override map keyed by itemId so expanding a
 * tool row survives virtualization (the row unmounts, the state does not).
 * Dock width and the per-thread dock tab persist through localStorage —
 * durable layout, nothing more.
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

const DOCK_TAB_KEY = "openade:dock-tab-by-thread";

/**
 * Which dock tab each thread was last left on. Spec section 11 asks for
 * per-thread tab state that survives a reload; `?pane=` alone cannot do it,
 * because the sidebar links carry no search param and a relaunch starts from
 * the bare route.
 *
 * Values are kept as plain strings: the tab union belongs to the dock, and
 * importing it here would make `state/ui` depend on the component that depends
 * on it. The caller narrows what it reads back.
 */
/** Absent, unparseable or foreign-shaped storage all mean "no memory yet". */
export const parseDockTabs = (raw: string | null | undefined): Readonly<Record<string, string>> => {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

const readDockTabs = (): Readonly<Record<string, string>> => {
  try {
    return parseDockTabs(globalThis.localStorage?.getItem(DOCK_TAB_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return {};
  }
};

const dockTabByThreadAtom = Atom.make<Readonly<Record<string, string>>>(readDockTabs());

export const useDockTabMemory = () => {
  const tabs = useAtomValue(dockTabByThreadAtom);
  const setTabs = useAtomSet(dockTabByThreadAtom);
  const remember = React.useCallback(
    (threadId: string, tab: string | null) => {
      setTabs((current) => {
        const next = { ...current };
        if (tab === null) {
          delete next[threadId];
        } else {
          next[threadId] = tab;
        }
        try {
          globalThis.localStorage?.setItem(DOCK_TAB_KEY, JSON.stringify(next));
        } catch {
          // localStorage can throw (private mode, quota); the atom still updates.
        }
        return next;
      });
    },
    [setTabs],
  );
  return [tabs, remember] as const;
};
