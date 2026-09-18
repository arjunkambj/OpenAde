import { describe, expect, it } from "vitest";

import { decideNavigation, type NavigationPolicy } from "./navigation";

const PACKAGED: NavigationPolicy = { appUrl: "openade://app/" };
const DEV: NavigationPolicy = {
  appUrl: "openade://app/",
  devServerUrl: "http://localhost:5173",
};

describe("decideNavigation", () => {
  it("allows the renderer to navigate within its own origin", () => {
    expect(decideNavigation("openade://app/", PACKAGED)).toEqual({ kind: "allow" });
    expect(decideNavigation("openade://app/index.html#/threads/1", PACKAGED)).toEqual({
      kind: "allow",
    });
  });

  it("refuses another host on the app scheme", () => {
    const decision = decideNavigation("openade://evil.example/", PACKAGED);

    expect(decision.kind).toBe("block");
  });

  /**
   * The finding: a plan is model output, and react-markdown renders
   * `[report](https://evil.example/)` as a live link. Following it in this
   * window would load the page with the preload — and its RPC token — attached.
   */
  it("sends an off-origin http(s) link to the OS browser instead of this window", () => {
    expect(decideNavigation("https://evil.example/x", PACKAGED)).toEqual({
      kind: "external",
      url: "https://evil.example/x",
    });
    expect(decideNavigation("http://127.0.0.1:4100/ws", PACKAGED)).toEqual({
      kind: "external",
      url: "http://127.0.0.1:4100/ws",
    });
  });

  it("blocks every other scheme, including one that would read the disk", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<script>fetch(1)</script>",
      "blob:openade://app/9f",
      "ftp://example.com/",
    ]) {
      expect(decideNavigation(url, PACKAGED).kind).toBe("block");
    }
  });

  it("blocks a url it cannot parse rather than falling through", () => {
    expect(decideNavigation("not a url", PACKAGED).kind).toBe("block");
    expect(decideNavigation("", PACKAGED).kind).toBe("block");
  });

  it("allows the dev server's origin in dev, and only that origin", () => {
    expect(decideNavigation("http://localhost:5173/", DEV)).toEqual({ kind: "allow" });
    expect(decideNavigation("http://localhost:5173/assets/index.js", DEV)).toEqual({
      kind: "allow",
    });
    // A different port is a different origin, dev or not.
    expect(decideNavigation("http://localhost:5174/", DEV).kind).toBe("external");
    expect(decideNavigation("https://localhost:5173/", DEV).kind).toBe("external");
  });
});
