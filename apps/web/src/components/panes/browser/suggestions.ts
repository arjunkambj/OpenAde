/**
 * What the address bar suggests: the project's running dev servers first,
 * then the pages its tabs have visited. Pure, so the matching and the
 * keyboard movement are tested without a popover.
 *
 * With nothing typed — or the field still showing the current page — every
 * server and the most recent pages are offered. Typing narrows both to what
 * contains the text (url, title, port or process name, ignoring case). A
 * visited page that is one of the servers' own root is not listed twice.
 */

import type { DevServer } from "@OpenAde/contracts/rpc";

import type { HistoryEntry } from "./history";

export interface Suggestion {
  readonly kind: "server" | "history";
  readonly url: string;
  /** The line a person reads: the server's url, or the page's title. */
  readonly label: string;
  /** The second line: the process serving it, or a titled page's url. */
  readonly detail: string | null;
}

/** The most visited pages offered at once. */
export const HISTORY_SUGGESTIONS = 8;

const canonical = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

export const suggestionsFor = (
  typed: string,
  current: string,
  servers: ReadonlyArray<DevServer>,
  history: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<Suggestion> => {
  const query = typed.trim().toLowerCase();
  const narrow = query !== "" && query !== current.trim().toLowerCase();
  const matches = (...fields: ReadonlyArray<string | null>) =>
    !narrow || fields.some((field) => field !== null && field.toLowerCase().includes(query));

  const serverUrls = new Set(servers.map((server) => canonical(server.url)));
  const fromServers = servers
    .filter((server) => matches(server.url, String(server.port), server.processName))
    .map((server): Suggestion => ({
      kind: "server",
      url: server.url,
      label: server.url,
      detail: server.processName,
    }));
  const fromHistory = history
    .filter((entry) => !serverUrls.has(canonical(entry.url)) && matches(entry.url, entry.title))
    .slice(0, HISTORY_SUGGESTIONS)
    .map((entry): Suggestion => ({
      kind: "history",
      url: entry.url,
      label: entry.title === "" ? entry.url : entry.title,
      detail: entry.title === "" ? null : entry.url,
    }));
  return [...fromServers, ...fromHistory];
};

/**
 * The suggestion the arrow keys land on: down from none is the first, up from
 * none the last, and past either end is none again — back to what was typed.
 */
export const moveActive = (
  suggestions: ReadonlyArray<Suggestion>,
  active: string | null,
  direction: "up" | "down",
): string | null => {
  if (suggestions.length === 0) return null;
  const index = active === null ? -1 : suggestions.findIndex((entry) => entry.url === active);
  if (index === -1) {
    return direction === "down" ? suggestions[0]!.url : suggestions.at(-1)!.url;
  }
  const next = direction === "down" ? index + 1 : index - 1;
  return suggestions[next]?.url ?? null;
};
