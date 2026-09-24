import { describe, expect, it } from "vitest";

import { isPaneUrl, normalizeAddress, SEARCH_URL } from "./address";

const searched = (text: string) => `${SEARCH_URL}${encodeURIComponent(text)}`;

describe("normalizeAddress", () => {
  it("keeps http(s) urls and about:blank as typed", () => {
    expect(normalizeAddress("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeAddress("  http://127.0.0.1:5173/  ")).toBe("http://127.0.0.1:5173/");
    expect(normalizeAddress("HTTPS://Example.com")).toBe("HTTPS://Example.com");
    expect(normalizeAddress("about:blank")).toBe("about:blank");
    expect(normalizeAddress("About:Blank")).toBe("about:blank");
  });

  it("never loads another scheme: file:, javascript:, data: and the rest are searched for", () => {
    for (const typed of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:config",
      "view-source:https://example.com",
      "ftp://example.com",
    ]) {
      const url = normalizeAddress(typed);
      expect(url).toBe(searched(typed));
      expect(url?.startsWith(SEARCH_URL)).toBe(true);
    }
  });

  it("gives a local host http:// and any other bare host https://", () => {
    expect(normalizeAddress("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeAddress("localhost")).toBe("http://localhost");
    expect(normalizeAddress("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
    expect(normalizeAddress("[::1]:4000")).toBe("http://[::1]:4000");
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("docs.example.com/guide#top")).toBe(
      "https://docs.example.com/guide#top",
    );
  });

  it("searches for words and returns nothing for blank input", () => {
    expect(normalizeAddress("effect schema union")).toBe(searched("effect schema union"));
    expect(normalizeAddress("vitest")).toBe(searched("vitest"));
    expect(normalizeAddress("https://")).toBe(searched("https://"));
    expect(normalizeAddress("   ")).toBeNull();
  });
});

describe("isPaneUrl", () => {
  it("admits http(s) and about:blank only", () => {
    expect(isPaneUrl("https://example.com")).toBe(true);
    expect(isPaneUrl("http://localhost:3000/x")).toBe(true);
    expect(isPaneUrl("about:blank")).toBe(true);
    expect(isPaneUrl("file:///etc/passwd")).toBe(false);
    expect(isPaneUrl("javascript:alert(1)")).toBe(false);
    expect(isPaneUrl("data:text/html,x")).toBe(false);
    expect(isPaneUrl("about:srcdoc")).toBe(false);
  });
});
