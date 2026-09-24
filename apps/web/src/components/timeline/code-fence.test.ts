import { describe, expect, it } from "vitest";

import {
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  codeFenceInfo,
  hastText,
  highlightable,
  openFenceOffset,
} from "./code-fence";

describe("codeFenceInfo", () => {
  it("reads a fence without a language as text", () => {
    expect(codeFenceInfo(undefined, undefined)).toEqual({ language: "text", label: "Text" });
    expect(codeFenceInfo([], undefined)).toEqual({ language: "text", label: "Text" });
  });

  it("maps aliases to the highlighter's ids and a display name", () => {
    expect(codeFenceInfo(["language-ts"], undefined)).toEqual({
      language: "typescript",
      label: "TypeScript",
    });
    expect(codeFenceInfo(["language-tsx"], undefined).language).toBe("tsx");
    expect(codeFenceInfo(["language-js"], undefined).language).toBe("javascript");
    for (const shell of ["sh", "bash", "shell", "zsh"]) {
      expect(codeFenceInfo([`language-${shell}`], undefined)).toEqual({
        language: "shellscript",
        label: "Shell",
      });
    }
    expect(codeFenceInfo(["language-console"], undefined).language).toBe("shellsession");
    expect(codeFenceInfo(["language-yml"], undefined).language).toBe("yaml");
    expect(codeFenceInfo(["language-md"], undefined).language).toBe("markdown");
    expect(codeFenceInfo(["language-py"], undefined).language).toBe("python");
    expect(codeFenceInfo(["language-rs"], undefined).language).toBe("rust");
    expect(codeFenceInfo(["language-go"], undefined).language).toBe("go");
    expect(codeFenceInfo(["language-diff"], undefined).language).toBe("diff");
    expect(codeFenceInfo(["language-jsonc"], undefined).language).toBe("jsonc");
    expect(codeFenceInfo(["language-TOML"], undefined).language).toBe("toml");
  });

  it("keeps an unknown language's word as the label but highlights it as text", () => {
    expect(codeFenceInfo(["language-klingon"], undefined)).toEqual({
      language: "text",
      label: "klingon",
    });
    // A key of the table's prototype is not a language.
    expect(codeFenceInfo(["language-constructor"], undefined).language).toBe("text");
  });

  it("names the file from a title in the meta, in either quote", () => {
    expect(codeFenceInfo(["language-ts"], 'title="src/app.ts"')).toEqual({
      language: "typescript",
      fileName: "src/app.ts",
      label: "src/app.ts",
    });
    expect(codeFenceInfo(["language-ts"], "title='app.ts' {1,3}").fileName).toBe("app.ts");
    expect(codeFenceInfo(["language-ts"], "filename=app.ts").fileName).toBe("app.ts");
  });

  it("names the file from a path-like word in the meta", () => {
    expect(codeFenceInfo(["language-ts"], "apps/web/src/lib/format.ts")).toEqual({
      language: "typescript",
      fileName: "apps/web/src/lib/format.ts",
      label: "apps/web/src/lib/format.ts",
    });
    expect(codeFenceInfo(["language-ts"], "{1,3} showLineNumbers").fileName).toBeUndefined();
  });

  it("splits lang:path", () => {
    expect(codeFenceInfo(["language-ts:src/app.ts"], undefined)).toEqual({
      language: "typescript",
      fileName: "src/app.ts",
      label: "src/app.ts",
    });
  });

  it("takes the language from the file when the path is the only word", () => {
    expect(codeFenceInfo(["language-src/main.rs"], undefined)).toEqual({
      language: "rust",
      fileName: "src/main.rs",
      label: "src/main.rs",
    });
    expect(codeFenceInfo(undefined, 'title="Dockerfile"').language).toBe("dockerfile");
    expect(codeFenceInfo(undefined, 'title="notes.xyz"').language).toBe("text");
  });

  it("lets an explicit language win over the file's extension", () => {
    expect(codeFenceInfo(["language-json"], 'title="config.txt"').language).toBe("json");
  });
});

describe("highlightable", () => {
  it("allows ordinary blocks", () => {
    expect(highlightable("const a = 1;\n")).toBe(true);
    expect(highlightable("x".repeat(HIGHLIGHT_MAX_CHARS))).toBe(true);
    expect(highlightable("\n".repeat(HIGHLIGHT_MAX_LINES - 1))).toBe(true);
  });

  it("refuses blocks over the character or the line cap", () => {
    expect(highlightable("x".repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
    expect(highlightable("\n".repeat(HIGHLIGHT_MAX_LINES))).toBe(false);
  });
});

describe("openFenceOffset", () => {
  it("is undefined when every fence is closed", () => {
    expect(openFenceOffset("plain text")).toBeUndefined();
    expect(openFenceOffset(["```ts", "a", "```", "after"].join("\n"))).toBeUndefined();
    expect(openFenceOffset(["~~~", "a", "~~~~"].join("\n"))).toBeUndefined();
  });

  it("points at the fence still open", () => {
    const text = ["Intro", "```ts", "const a"].join("\n");
    expect(openFenceOffset(text)).toBe("Intro\n".length);
  });

  it("closes only on the same character at least as long, with nothing after it", () => {
    expect(openFenceOffset(["````", "```", "a"].join("\n"))).toBe(0);
    expect(openFenceOffset(["```", "~~~", "a"].join("\n"))).toBe(0);
    expect(openFenceOffset(["```", "``` ts", "a"].join("\n"))).toBe(0);
  });

  it("ignores a backtick run whose info holds a backtick", () => {
    expect(openFenceOffset("```not `a` fence```")).toBeUndefined();
  });
});

describe("hastText", () => {
  it("joins the text of a subtree", () => {
    expect(
      hastText({
        type: "element",
        children: [
          { type: "text", value: "a" },
          { type: "element", children: [{ type: "text", value: "b" }] },
        ],
      }),
    ).toBe("ab");
  });
});
