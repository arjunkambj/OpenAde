import { describe, expect, it } from "vitest";

import { linkToOpen } from "./terminal-links";

const plain = { metaKey: false, ctrlKey: false };
const meta = { metaKey: true, ctrlKey: false };
const ctrl = { metaKey: false, ctrlKey: true };

describe("linkToOpen", () => {
  it("opens an http(s) link on a mod-click", () => {
    expect(linkToOpen("http://localhost:5173/", meta, "meta")).toBe("http://localhost:5173/");
    expect(linkToOpen("https://example.com/a?b=1#c", ctrl, "ctrl")).toBe(
      "https://example.com/a?b=1#c",
    );
  });

  it("ignores a plain click", () => {
    expect(linkToOpen("https://example.com/", plain, "meta")).toBeNull();
    expect(linkToOpen("https://example.com/", plain, "ctrl")).toBeNull();
  });

  it("wants the platform's own modifier, not the other one", () => {
    expect(linkToOpen("https://example.com/", ctrl, "meta")).toBeNull();
    expect(linkToOpen("https://example.com/", meta, "ctrl")).toBeNull();
  });

  it("opens nothing but http and https", () => {
    expect(linkToOpen("file:///etc/passwd", meta, "meta")).toBeNull();
    expect(linkToOpen("javascript:alert(1)", meta, "meta")).toBeNull();
    expect(linkToOpen("vscode://file/a.ts", meta, "meta")).toBeNull();
  });

  it("ignores text that is not a URL", () => {
    expect(linkToOpen("example.com", meta, "meta")).toBeNull();
    expect(linkToOpen("", meta, "meta")).toBeNull();
  });
});
