/**
 * What the command palette makes of its input. A leading ">" switches it to
 * commands only — the thread list steps aside — and the rest of the text is
 * what the entries are matched against, so "> set" finds the settings pages
 * rather than nothing with a ">" in it.
 */

import { defaultFilter } from "cmdk";

export type PaletteQuery = {
  readonly commandsOnly: boolean;
  readonly query: string;
};

export function paletteQuery(search: string): PaletteQuery {
  const trimmed = search.trim();
  if (trimmed.startsWith(">")) {
    return { commandsOnly: true, query: trimmed.slice(1).trim() };
  }
  return { commandsOnly: false, query: trimmed };
}

/**
 * The palette's matcher: the stock fuzzy score, run against the query rather
 * than the raw input, so the ">" itself never has to match. It reads the query
 * from the text it is handed instead of closing over one, so it can never score
 * against a query from an earlier keystroke. A bare ">" has nothing left to
 * match, so every entry stays.
 */
export function paletteFilter(
  value: string,
  search: string,
  keywords?: ReadonlyArray<string>,
): number {
  const { query } = paletteQuery(search);
  return query === ""
    ? 1
    : defaultFilter(value, query, keywords === undefined ? undefined : [...keywords]);
}
