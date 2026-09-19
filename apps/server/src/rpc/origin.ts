/**
 * Who may talk to the server's loopback endpoints.
 *
 * Every one of them is bearer-gated, but a page in any browser can still reach
 * 127.0.0.1, so a request that carries an `Origin` we do not recognise is
 * refused before the token is even looked at. The harness — a CLI client —
 * sends no `Origin` header at all, which is the `undefined` case.
 *
 * `Origin: null` is *not* that case, and treating it as one was a bypass built
 * into the check: an opaque origin is exactly what a website sends from a
 * sandboxed iframe (`<iframe sandbox="allow-scripts" srcdoc=…>`), from a
 * `data:` document and from a `file:` page, so any remote page could put its
 * fetches into the allowed class at will. The bearer is still the real control;
 * this is the defence in depth that was silently not there.
 */
export const isLoopbackOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined || origin === "") {
    return true;
  }
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
};
