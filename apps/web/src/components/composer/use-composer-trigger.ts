/**
 * The trigger popovers' own state (`/` commands, `#` files, `@` and `$`
 * references): which trigger is open, which row the keyboard is on, and which
 * level of the slash menu is showing.
 *
 * It lives here rather than in `composer.tsx` because it is a small state
 * machine with three invariants that are easy to break one at a time: opening a
 * trigger of a different kind resets both the level and the highlight, closing
 * resets all three, and the caret — not the last keystroke — decides whether a
 * trigger is open at all, which is why `refresh` reads the element.
 */

import {
  detectComposerTrigger,
  type ComposerTrigger,
} from "@OpenAde/client-runtime/composerTrigger";
import * as React from "react";

import type { SlashLevel } from "@/components/composer/slash-menu";

export interface ComposerTriggerState {
  readonly trigger: ComposerTrigger | null;
  readonly activeIndex: number;
  readonly slashLevel: SlashLevel;
  readonly setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Descend into a slash sub-level, highlight reset. */
  readonly setLevel: (level: SlashLevel) => void;
  /** Store a detected trigger; a kind change resets level and highlight. */
  readonly open: (next: ComposerTrigger | null) => void;
  readonly close: () => void;
  /** Re-detect from the textarea's current value and caret. */
  readonly refresh: () => void;
  /**
   * After a pick has rewritten the text: on the next frame, focus the
   * textarea, put the caret at `caret` and re-detect from there.
   */
  readonly placeCaret: (caret: number) => void;
}

export function useComposerTrigger(
  textarea: React.RefObject<HTMLTextAreaElement | null>,
): ComposerTriggerState {
  const [trigger, setTrigger] = React.useState<ComposerTrigger | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [slashLevel, setSlashLevel] = React.useState<SlashLevel>("root");

  const open = React.useCallback((next: ComposerTrigger | null) => {
    setTrigger((current) => {
      if (next === null || current === null || next.kind !== current.kind) {
        setSlashLevel("root");
        setActiveIndex(0);
      }
      return next;
    });
  }, []);

  const close = React.useCallback(() => {
    setTrigger(null);
    setSlashLevel("root");
    setActiveIndex(0);
  }, []);

  const setLevel = React.useCallback((level: SlashLevel) => {
    setSlashLevel(level);
    setActiveIndex(0);
  }, []);

  const refresh = React.useCallback(() => {
    const el = textarea.current;
    if (el !== null) {
      open(detectComposerTrigger(el.value, el.selectionStart ?? el.value.length));
    }
  }, [open, textarea]);

  const placeCaret = React.useCallback(
    (caret: number) =>
      requestAnimationFrame(() => {
        const el = textarea.current;
        if (el !== null) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
        refresh();
      }),
    [refresh, textarea],
  );

  return {
    trigger,
    activeIndex,
    slashLevel,
    setActiveIndex,
    setLevel,
    open,
    close,
    refresh,
    placeCaret,
  };
}
