import { Kbd, KbdGroup } from "@OpenAde/ui/components/kbd";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const mod = isMac ? "⌘" : "Ctrl";
const shift = isMac ? "⇧" : "Shift";

export const shortcutIds = ["search", "toggle", "newChat", "skills", "settings"] as const;

export type ShortcutId = (typeof shortcutIds)[number];

const shortcutKeycaps: Record<ShortcutId, readonly string[]> = {
  search: [mod, "K"],
  toggle: [mod, "B"],
  newChat: [mod, "N"],
  skills: [mod, shift, "S"],
  settings: [mod, ","],
};

export function shortcutKeys(id: ShortcutId) {
  return shortcutKeycaps[id];
}

function isMod(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey;
}

export function matchShortcut(id: ShortcutId, event: KeyboardEvent) {
  if (!isMod(event) || event.altKey || event.repeat || event.isComposing) {
    return false;
  }

  switch (id) {
    case "search":
      return event.code === "KeyK" && !event.shiftKey;
    case "toggle":
      return event.code === "KeyB" && !event.shiftKey;
    case "newChat":
      return event.code === "KeyN" && !event.shiftKey;
    case "skills":
      return event.code === "KeyS" && event.shiftKey;
    case "settings":
      return event.code === "Comma" && !event.shiftKey;
  }
}

export function ShortcutKbd({ id }: { id: ShortcutId }) {
  return (
    <KbdGroup>
      {shortcutKeys(id).map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
}
