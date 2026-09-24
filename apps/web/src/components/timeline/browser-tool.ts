/**
 * A timeline row's words for the agent's in-app browser calls
 * (`mcp__openade__browser_*`, served by the server's MCP gateway): what the
 * agent did to the page, in a sentence, instead of the tool's raw name.
 * Anything else — another server's tool, or a browser tool this does not
 * know — is `null`, and the row stays a plain MCP row.
 */

const PREFIX = "mcp__openade__browser_";

const MAX = 60;

const str = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const line = value.trim().split("\n", 1)[0]?.trim() ?? "";
  if (line === "") return undefined;
  return line.length > MAX ? `${line.slice(0, MAX)}…` : line;
};

const num = (input: unknown, key: string): number | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const flag = (input: unknown, key: string): boolean =>
  typeof input === "object" && input !== null && (input as Record<string, unknown>)[key] === true;

const with_ = (verb: string, target: string | undefined): string =>
  target === undefined ? verb : `${verb} ${target}`;

export const isBrowserTool = (name: string): boolean => name.startsWith(PREFIX);

/** The sentence for a browser call, or `null` when `name` is not one. */
export const browserToolLabel = (name: string, input: unknown): string | null => {
  if (!isBrowserTool(name)) return null;
  switch (name.slice(PREFIX.length)) {
    case "open":
      return with_("Opened", str(input, "url"));
    case "snapshot":
      return flag(input, "interactive") ? "Read the page's controls" : "Read the page";
    case "click":
      return with_("Clicked", str(input, "selector"));
    case "fill":
      return with_("Filled", str(input, "selector"));
    case "type":
      return "Typed text";
    case "press":
      return with_("Pressed", str(input, "key"));
    case "scroll": {
      const px = num(input, "px");
      return `Scrolled ${str(input, "direction") ?? "down"}${px === undefined ? "" : ` ${px}px`}`;
    }
    case "wait": {
      const ms = num(input, "ms");
      const target =
        str(input, "selector") ??
        str(input, "text") ??
        str(input, "url") ??
        str(input, "load") ??
        (str(input, "fn") === undefined ? undefined : "a condition");
      if (target !== undefined) return `Waited for ${target}`;
      return ms === undefined ? "Waited" : `Waited ${ms} ms`;
    }
    case "get": {
      const what = str(input, "what");
      if (what === "text") return with_("Read the text of", str(input, "selector"));
      return what === undefined ? "Read the page" : `Read the page ${what}`;
    }
    case "screenshot":
      return flag(input, "full") ? "Took a full-page screenshot" : "Took a screenshot";
    case "eval":
      return "Ran JavaScript in the page";
    case "tabs": {
      switch (str(input, "action")) {
        case "new":
          return with_("Opened a new tab", str(input, "url"));
        case "switch":
          return with_("Switched to tab", str(input, "tab"));
        case "close":
          return "Closed a tab";
        default:
          return "Listed the tabs";
      }
    }
    default:
      return null;
  }
};
