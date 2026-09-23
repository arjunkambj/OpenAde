import { describe, expect, it } from "vitest";

import {
  allowedImportsFor,
  connectorLeaks,
  KIND_LITERAL_EXEMPT,
  REFERENCE_NAMES,
  referenceNameLeaks,
  rendererLeaks,
} from "./boundary-rules.mjs";

const lines = (leaks) => leaks.map((leak) => leak.line);

describe("allowedImportsFor", () => {
  it("keeps connector packages out of the server's production files", () => {
    expect(allowedImportsFor("apps/server/src/rpc/handlers.ts", "apps/server")).not.toContain(
      "connector-cmd",
    );
  });

  it("lets the composition root and server tests import the real connector", () => {
    expect(allowedImportsFor("apps/server/src/boot.ts", "apps/server")).toContain("connector-cmd");
    expect(
      allowedImportsFor("apps/server/src/hooks/cmdConformance.test.ts", "apps/server"),
    ).toContain("connector-cmd");
    expect(allowedImportsFor("apps/server/test/e2e/harness.ts", "apps/server")).toContain(
      "connector-cmd",
    );
  });

  it("gives test extras only to tests, and nothing to a workspace with no rule", () => {
    expect(allowedImportsFor("apps/server/src/main.ts", "apps/server")).not.toContain("testkit");
    expect(allowedImportsFor("apps/server/src/main.test.ts", "apps/server")).toContain("testkit");
    expect(
      allowedImportsFor("packages/connector-next/src/a.ts", "packages/connector-next"),
    ).toEqual(["connector-sdk", "contracts", "shared"]);
    expect(allowedImportsFor("apps/unknown/src/a.ts", "apps/unknown")).toBeUndefined();
  });
});

describe("connectorLeaks", () => {
  const importing = (specifier) => `import { x } from "${specifier}";\n`;

  it("fails a server file that imports a concrete connector", () => {
    const leaks = connectorLeaks(
      "apps/server/src/rpc/handlers.ts",
      `// the handlers\n${importing("@OpenAde/connector-cmd/definition")}`,
    );
    expect(lines(leaks)).toEqual([2]);
    expect(leaks[0].message).toContain("@OpenAde/connector-cmd");
  });

  it("catches dynamic imports and any connector package but the sdk", () => {
    expect(
      connectorLeaks("apps/web/src/lib/a.ts", "await import(`@OpenAde/connector-next/x`);\n"),
    ).toHaveLength(1);
    expect(
      connectorLeaks("packages/client-runtime/src/a.ts", importing("@OpenAde/connector-sdk/ids")),
    ).toEqual([]);
  });

  it("passes the composition root", () => {
    expect(
      connectorLeaks(
        "apps/server/src/boot.ts",
        `${importing("@OpenAde/connector-cmd/definition")}const kind = "cmd";\n`,
      ),
    ).toEqual([]);
  });

  it("passes server tests and the end-to-end harness", () => {
    const source = `${importing("@OpenAde/connector-cmd/definition")}const kind = "cmd";\n`;
    expect(connectorLeaks("apps/server/src/hooks/cmdConformance.test.ts", source)).toEqual([]);
    expect(connectorLeaks("apps/server/test/e2e/harness.ts", source)).toEqual([]);
  });

  it("fails a quoted connector kind in the server and the renderer", () => {
    expect(
      lines(
        connectorLeaks("apps/server/src/rpc/services.ts", 'const a = 1;\nif (kind === "cmd") {}\n'),
      ),
    ).toEqual([2]);
    expect(connectorLeaks("apps/web/src/lib/routing.ts", 'const x = { kind: "codex" };\n')).toEqual(
      [expect.objectContaining({ line: 1 })],
    );
    expect(connectorLeaks("apps/web/src/lib/routing.ts", "const x = `opencode`;\n")).toHaveLength(
      1,
    );
    expect(connectorLeaks("apps/server/src/a.ts", "const x = 'claude';\n")).toHaveLength(1);
  });

  it("passes harness config paths, which are not kinds", () => {
    expect(
      connectorLeaks(
        "apps/server/src/permissions/sensitivePaths.ts",
        'const dirs = new Set([".claude", ".codex", ".config/opencode"]);\n',
      ),
    ).toEqual([]);
  });

  it("exempts the keyboard modifier in keybindings by exact path only", () => {
    const source = 'const modifiers = ["cmd", "ctrl"];\n';
    expect(KIND_LITERAL_EXEMPT.has("packages/client-runtime/src/keybindings.ts")).toBe(true);
    expect(connectorLeaks("packages/client-runtime/src/keybindings.ts", source)).toEqual([]);
    expect(connectorLeaks("packages/client-runtime/src/shortcuts.ts", source)).toHaveLength(1);
  });

  it("does not read other workspaces", () => {
    expect(
      connectorLeaks("packages/connector-cmd/src/definition.ts", 'export const kind = "cmd";\n'),
    ).toEqual([]);
  });
});

describe("rendererLeaks", () => {
  it("fails a harness name as a word in any renderer file", () => {
    expect(rendererLeaks("apps/web/src/lib/a.ts", "// talks to codex\n")).toHaveLength(1);
    expect(rendererLeaks("apps/web/src/lib/a.css", ".opencode-row {}\n")).toHaveLength(1);
    expect(rendererLeaks("apps/web/src/lib/codex.ts", null)).toHaveLength(1);
  });

  it("skips the icon set and files outside the renderer", () => {
    expect(rendererLeaks("apps/web/src/components/ui/icons/claude.svg", "claude")).toEqual([]);
    expect(rendererLeaks("apps/server/src/a.ts", "claude")).toEqual([]);
  });
});

describe("referenceNameLeaks", () => {
  const variants = (name) => [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)];

  it("fails each reference name in contents, whatever its case", () => {
    for (const name of REFERENCE_NAMES) {
      for (const spelling of variants(name)) {
        const leaks = referenceNameLeaks("packages/shared/src/a.ts", `ok\n// like ${spelling}\n`);
        expect(lines(leaks), spelling).toEqual([2]);
      }
    }
  });

  it("fails each reference name in a file or directory name", () => {
    for (const name of REFERENCE_NAMES) {
      const slug = name.replace(/ /g, "-");
      expect(referenceNameLeaks(`apps/web/src/${slug}.ts`, "ok\n"), name).toHaveLength(1);
      expect(referenceNameLeaks(`scripts/${slug}/notes.txt`, null), name).toHaveLength(1);
    }
  });

  it("reads the top-level docs but not docs/plans", () => {
    const text = `see ${REFERENCE_NAMES[0]}\n`;
    expect(referenceNameLeaks("docs/architecture.md", text)).toHaveLength(1);
    expect(referenceNameLeaks("docs/plans/harness-plan.md", text)).toEqual([]);
    expect(referenceNameLeaks("docs/launch/post.txt", text)).toEqual([]);
  });

  it("skips recorded fixtures, dependencies and build output", () => {
    const text = `${REFERENCE_NAMES[1]}\n`;
    expect(referenceNameLeaks("packages/testkit/fixtures/cmd/a.json", text)).toEqual([]);
    expect(referenceNameLeaks("packages/contracts/fixtures/a.json", text)).toEqual([]);
    expect(referenceNameLeaks("apps/web/node_modules/x/index.js", text)).toEqual([]);
    expect(referenceNameLeaks("apps/web/dist/a.js", text)).toEqual([]);
    expect(referenceNameLeaks("apps/desktop/out/main.js", text)).toEqual([]);
  });

  it("passes ordinary text, including harness names we integrate", () => {
    expect(
      referenceNameLeaks("docs/architecture.md", "Command Code, Claude Code, Codex, OpenCode\n"),
    ).toEqual([]);
  });
});
