/**
 * The pages a project's browser tabs have visited, newest first — what the
 * address bar suggests beside the project's dev servers.
 *
 * Kept per project (a history of one app's pages is noise in another's), in
 * this window's localStorage (`@/state/browser-history`), capped at
 * `HISTORY_LIMIT` entries each. Only http(s) pages are remembered: the pane
 * never loads anything else, and `about:blank` is not a place anyone goes
 * back to. A url visited again moves to the front with its latest title.
 */

export interface HistoryEntry {
  readonly url: string;
  readonly title: string;
}

/** Every project's history: `projectId -> entries`, newest first. */
export type BrowserHistory = Readonly<Record<string, ReadonlyArray<HistoryEntry>>>;

/** The most pages one project remembers. */
export const HISTORY_LIMIT = 50;

/** The longest title kept; a page can set any title it likes. */
const TITLE_LIMIT = 200;

/** `url` as the history keeps it, or null when it is not an http(s) page. */
export const historyUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
};

/** One project's entries with a visit recorded; the same array when nothing changes. */
export const recordVisit = (
  entries: ReadonlyArray<HistoryEntry>,
  url: string,
  title: string,
): ReadonlyArray<HistoryEntry> => {
  const href = historyUrl(url);
  if (href === null) return entries;
  const entry = { url: href, title: title.trim().slice(0, TITLE_LIMIT) };
  const first = entries[0];
  if (first !== undefined && first.url === entry.url && first.title === entry.title) {
    return entries;
  }
  // A revisit without a title yet (the page is still loading) keeps the one
  // it had last time.
  const previous = entries.find((existing) => existing.url === entry.url);
  const kept = entry.title === "" && previous !== undefined ? previous : entry;
  return [kept, ...entries.filter((existing) => existing.url !== entry.url)].slice(
    0,
    HISTORY_LIMIT,
  );
};

/** Every project's history with one visit recorded. */
export const withVisit = (
  history: BrowserHistory,
  projectId: string,
  url: string,
  title: string,
): BrowserHistory => {
  const entries = history[projectId] ?? [];
  const next = recordVisit(entries, url, title);
  return next === entries ? history : { ...history, [projectId]: next };
};

/** Stored history, keeping only well-formed http(s) entries; anything else is none. */
export const parseHistory = (raw: string | null | undefined): BrowserHistory => {
  if (raw === null || raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const history: Record<string, ReadonlyArray<HistoryEntry>> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      // Oldest first through `recordVisit`, so its dedupe and cap apply.
      history[projectId] = [...value]
        .reverse()
        .filter(
          (entry): entry is HistoryEntry =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as HistoryEntry).url === "string" &&
            typeof (entry as HistoryEntry).title === "string",
        )
        .reduce<ReadonlyArray<HistoryEntry>>(
          (entries, entry) => recordVisit(entries, entry.url, entry.title),
          [],
        );
    }
    return history;
  } catch {
    return {};
  }
};
