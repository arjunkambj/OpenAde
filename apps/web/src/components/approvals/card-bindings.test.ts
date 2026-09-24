/**
 * The interaction cards' keys, resolved the way the listener resolves them:
 * the shipped table, the matcher, and the context a real press would build.
 * Their claim rule is the `when` clause now, so these are the cases the old
 * capture listener existed to get right.
 */

import { resolveKeybinding, type ShortcutEvent } from "@poseidon/client-runtime/keybindings";
import type { Keybinding } from "@poseidon/contracts/settings";
import { describe, expect, it } from "vitest";

import { keybindingContext, type FocusSnapshot } from "@/lib/keybinding-context";
import { effectiveKeybindings } from "@/lib/keybindings";

const press = (key: string, patch: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

const BODY: FocusSnapshot = { editable: false, surface: undefined, overlayOpen: false };
const COMPOSER: FocusSnapshot = { editable: true, surface: "composer", overlayOpen: false };
const DIALOG: FocusSnapshot = { editable: false, surface: undefined, overlayOpen: true };

const resolve = (
  event: ShortcutEvent,
  focus: FocusSnapshot,
  flags: Readonly<Record<string, boolean>>,
  table: ReadonlyArray<Keybinding> = effectiveKeybindings([]),
): string | null =>
  resolveKeybinding(
    table,
    event,
    keybindingContext(focus, (name) => flags[name], true),
    "meta",
  )?.command ?? null;

describe("approval card keys", () => {
  const approval = { approvalPending: true, turnRunning: true };

  it("answers the four decisions with focus outside a field", () => {
    expect(resolve(press("1"), BODY, approval)).toBe("approval.allowOnce");
    expect(resolve(press("2"), BODY, approval)).toBe("approval.allowSession");
    expect(resolve(press("3"), BODY, approval)).toBe("approval.allowAlways");
    expect(resolve(press("d"), BODY, approval)).toBe("approval.deny");
    expect(resolve(press("Escape"), BODY, approval)).toBe("approval.deny");
  });

  it("leaves digits to the composer while it has focus", () => {
    expect(resolve(press("1"), COMPOSER, approval)).toBeNull();
    expect(resolve(press("d"), COMPOSER, approval)).toBeNull();
  });

  it("stops the turn on Escape in the composer instead of denying", () => {
    expect(resolve(press("Escape"), COMPOSER, approval)).toBe("thread.interrupt");
  });

  it("does nothing while a dialog or menu is on screen", () => {
    // The regression the old capture listener was rewritten for: Escape in the
    // palette must never deny a tool call the user has not looked at.
    expect(resolve(press("Escape"), DIALOG, approval)).toBeNull();
    expect(resolve(press("1"), DIALOG, approval)).toBeNull();
  });

  it("matches modifiers exactly, so Shift+D no longer denies", () => {
    expect(resolve(press("D", { shiftKey: true }), BODY, approval)).toBeNull();
    // Mod+1 is a chord of its own, jumping to the first thread.
    expect(resolve(press("1", { metaKey: true }), BODY, approval)).toBe("thread.jump.1");
  });

  it("follows a rebinding in the table", () => {
    const table = effectiveKeybindings([
      { command: "approval.deny", shortcut: "N", when: "approvalPending && !inputFocus" },
    ]);
    expect(resolve(press("n"), BODY, approval, table)).toBe("approval.deny");
    expect(resolve(press("d"), BODY, approval, table)).toBeNull();
  });
});

describe("plan card keys", () => {
  const plan = { planPending: true };

  it("answers the three plan actions", () => {
    expect(resolve(press("1"), BODY, plan)).toBe("plan.accept");
    expect(resolve(press("2"), BODY, plan)).toBe("plan.acceptAndRun");
    expect(resolve(press("3"), BODY, plan)).toBe("plan.revise");
  });

  it("claims no Escape — a plan does not answer for the user", () => {
    expect(resolve(press("Escape"), BODY, plan)).toBeNull();
  });

  it("stands down in a field and behind a dialog", () => {
    expect(resolve(press("1"), COMPOSER, plan)).toBeNull();
    expect(resolve(press("1"), DIALOG, plan)).toBeNull();
  });
});

describe("question card keys", () => {
  it("picks option N with a number key", () => {
    const question = { questionPending: true };
    expect(resolve(press("1"), BODY, question)).toBe("question.option.1");
    expect(resolve(press("9"), BODY, question)).toBe("question.option.9");
    expect(resolve(press("4"), COMPOSER, question)).toBeNull();
  });

  it("lets nothing answer digits with no card up", () => {
    expect(resolve(press("1"), BODY, {})).toBeNull();
  });
});

describe("thread.interrupt", () => {
  it("fires on Escape while a turn runs", () => {
    expect(resolve(press("Escape"), BODY, { turnRunning: true })).toBe("thread.interrupt");
    expect(resolve(press("Escape"), COMPOSER, { turnRunning: true })).toBe("thread.interrupt");
  });

  it("does nothing when no turn runs or a dialog is open", () => {
    expect(resolve(press("Escape"), BODY, {})).toBeNull();
    expect(resolve(press("Escape"), COMPOSER, {})).toBeNull();
    expect(resolve(press("Escape"), DIALOG, { turnRunning: true })).toBeNull();
  });

  it("still evaluates a stored clause written with threadRunning", () => {
    const table = effectiveKeybindings([
      { command: "thread.interrupt", shortcut: "Mod+.", when: "threadRunning" },
    ]);
    const stop = press(".", { metaKey: true });
    expect(resolve(stop, BODY, { turnRunning: true }, table)).toBe("thread.interrupt");
    expect(resolve(stop, BODY, {}, table)).toBeNull();
  });
});
