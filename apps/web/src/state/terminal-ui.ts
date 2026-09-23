/**
 * The terminal drawer's layout: whether each thread's drawer is open, and how
 * tall the drawer is. Both persist through localStorage — durable layout,
 * nothing more — the way the dock's width and tab do in `@/state/ui`.
 *
 * The tabs themselves are not here: which terminals a thread has is the
 * server's to say, and the drawer keeps its view of them in
 * `@/components/terminal/drawer-state`.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

const OPEN_KEY = "openade:terminal-open-by-thread";

/**
 * Absent, unparseable or foreign-shaped storage all mean "no drawer open".
 * Only `true` entries are kept: a closed drawer is the absence of a key.
 */
export const parseOpenByThread = (
  raw: string | null | undefined,
): Readonly<Record<string, true>> => {
  if (raw === null || raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry) => entry[1] === true)
        .map(([threadId]) => [threadId, true as const]),
    );
  } catch {
    return {};
  }
};

/** The map with one thread's drawer set; closing drops the key. */
export const withDrawerOpen = (
  openByThread: Readonly<Record<string, true>>,
  threadId: string,
  open: boolean,
): Readonly<Record<string, true>> => {
  if (open === (openByThread[threadId] === true)) {
    return openByThread;
  }
  const next = { ...openByThread };
  if (open) {
    next[threadId] = true;
  } else {
    delete next[threadId];
  }
  return next;
};

const readOpenByThread = (): Readonly<Record<string, true>> => {
  try {
    return parseOpenByThread(globalThis.localStorage?.getItem(OPEN_KEY));
  } catch {
    // Reading localStorage itself throws when site data is blocked.
    return {};
  }
};

const openByThreadAtom = Atom.make<Readonly<Record<string, true>>>(readOpenByThread());

/** `[open, setOpen]` for one thread's terminal drawer. */
export const useTerminalOpen = (threadId: string) => {
  const open = useAtomValue(
    openByThreadAtom,
    React.useCallback(
      (openByThread: Readonly<Record<string, true>>) => openByThread[threadId] === true,
      [threadId],
    ),
  );
  const setOpenByThread = useAtomSet(openByThreadAtom);
  const setOpen = React.useCallback(
    (update: boolean | ((open: boolean) => boolean)) =>
      setOpenByThread((current) => {
        const wanted = typeof update === "function" ? update(current[threadId] === true) : update;
        const next = withDrawerOpen(current, threadId, wanted);
        if (next !== current) {
          try {
            globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(next));
          } catch {
            // localStorage can throw (private mode, quota); the atom still updates.
          }
        }
        return next;
      }),
    [setOpenByThread, threadId],
  );
  return [open, setOpen] as const;
};

const HEIGHT_KEY = "openade:terminal-height";
const HEIGHT_DEFAULT = 280;
export const DRAWER_HEIGHT_MIN = 120;
/** The drawer may take this share of the thread column, and no more. */
export const DRAWER_HEIGHT_MAX_FRACTION = 0.7;
/** Stands in for the column's height before one has been measured. */
const COLUMN_HEIGHT_FALLBACK = 2000;

/**
 * Clamp to `[DRAWER_HEIGHT_MIN, column × DRAWER_HEIGHT_MAX_FRACTION]`, with the
 * minimum winning when a short window inverts the two.
 */
export const clampDrawerHeight = (height: number, columnHeight: number): number =>
  Math.max(
    DRAWER_HEIGHT_MIN,
    Math.min(Math.round(columnHeight * DRAWER_HEIGHT_MAX_FRACTION), Math.round(height)),
  );

/** Absent or unparseable storage means the default height. */
export const parseDrawerHeight = (raw: string | null | undefined): number => {
  if (raw === null || raw === undefined) {
    return HEIGHT_DEFAULT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed)
    ? clampDrawerHeight(parsed, COLUMN_HEIGHT_FALLBACK)
    : HEIGHT_DEFAULT;
};

const readDrawerHeight = (): number => {
  try {
    return parseDrawerHeight(globalThis.localStorage?.getItem(HEIGHT_KEY));
  } catch {
    return HEIGHT_DEFAULT;
  }
};

/** Drawer height in px; mirrored to localStorage on every write. */
const drawerHeightAtom = Atom.make<number>(readDrawerHeight());

export const useDrawerHeight = () => {
  const height = useAtomValue(drawerHeightAtom);
  const setHeight = useAtomSet(drawerHeightAtom);
  const setPersistedHeight = React.useCallback(
    (next: number, columnHeight: number) => {
      const clamped = clampDrawerHeight(next, columnHeight);
      try {
        globalThis.localStorage?.setItem(HEIGHT_KEY, String(clamped));
      } catch {
        // localStorage can throw (private mode, quota); the atom still updates.
      }
      setHeight(clamped);
    },
    [setHeight],
  );
  return [height, setPersistedHeight] as const;
};
