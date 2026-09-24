/**
 * What the pane's address field turns into a url.
 *
 * A pane tab is a page on the web, so the field only ever produces an
 * http(s) url or `about:blank`. Any other scheme — `file:`, `javascript:`,
 * `data:`, `chrome:` — is never loaded: it is searched for like any other
 * text. A bare host gets a scheme: `http://` for this machine (a local dev
 * server rarely speaks TLS), `https://` for everything else.
 */

/** The search a typed phrase becomes. */
export const SEARCH_URL = "https://duckduckgo.com/?q=";

const WEB = /^https?:\/\//i;
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
/** A host: a dotted name or IPv4, an optional port, then a path, query or nothing. */
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:[/?#]|$)/i;

const parses = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.hostname !== "";
  } catch {
    return false;
  }
};

const search = (text: string): string => `${SEARCH_URL}${encodeURIComponent(text)}`;

/** The url the pane loads for what was typed, or null for nothing to load. */
export const normalizeAddress = (raw: string): string | null => {
  const text = raw.trim();
  if (text === "") return null;
  if (text.toLowerCase() === "about:blank") return "about:blank";
  if (WEB.test(text)) return parses(text) ? text : search(text);
  if (/\s/.test(text)) return search(text);
  if (LOCAL_HOST.test(text) && parses(`http://${text}`)) return `http://${text}`;
  if (BARE_HOST.test(text) && parses(`https://${text}`)) return `https://${text}`;
  return search(text);
};

/** Whether a pane tab may load `url`: http(s) and `about:blank` only. */
export const isPaneUrl = (url: string): boolean =>
  url.toLowerCase() === "about:blank" || (WEB.test(url) && parses(url));
