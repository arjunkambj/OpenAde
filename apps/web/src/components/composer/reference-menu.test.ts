import type { PluginSummary, SkillSummary } from "@poseidon/contracts/connectors";
import { describe, expect, it } from "vitest";

import type { MenuSource } from "@/components/composer/menu-source";
import {
  REFERENCE_MENU_LABELS,
  referenceMenuEmptyLabel,
  referenceMenuItems,
  referenceToken,
  sameReference,
} from "@/components/composer/reference-menu";

const plugins: ReadonlyArray<PluginSummary> = [
  { name: "formatter", description: "Formats changed files", scope: "user", enabled: true },
  { name: "release-notes", description: "Drafts release notes", scope: "project", enabled: true },
  { name: "retired", description: "Switched off", enabled: false },
];

const skills: ReadonlyArray<SkillSummary> = [
  {
    name: "health-checks",
    path: "/skills/health-checks/SKILL.md",
    description: "Run the service health checks",
    enabled: true,
  },
  { name: "smoke-tests", path: "/skills/smoke-tests/SKILL.md", enabled: true },
  { name: "parked", path: "/skills/parked/SKILL.md", enabled: false },
];

const rows = (kind: "mention" | "skill", query = "") =>
  referenceMenuItems({ kind, query, plugins, skills });

describe("referenceMenuItems for @", () => {
  it("lists plugins, then skills, each under its group", () => {
    expect(rows("mention").map((item) => [item.group, item.label])).toEqual([
      ["Plugins", "formatter"],
      ["Plugins", "release-notes"],
      ["Skills", "health-checks"],
      ["Skills", "smoke-tests"],
    ]);
  });

  it("carries the typed reference each row adds", () => {
    expect(rows("mention").map((item) => item.reference)).toEqual([
      { kind: "plugin", name: "formatter" },
      { kind: "plugin", name: "release-notes" },
      { kind: "skill", name: "health-checks" },
      { kind: "skill", name: "smoke-tests" },
    ]);
  });

  it("leaves disabled plugins and skills out", () => {
    const labels = rows("mention").map((item) => item.label);
    expect(labels).not.toContain("retired");
    expect(labels).not.toContain("parked");
  });

  it("filters by name, ignoring case", () => {
    expect(rows("mention", "form").map((item) => item.label)).toEqual(["formatter"]);
    expect(rows("mention", "HEALTH").map((item) => item.label)).toEqual(["health-checks"]);
    expect(rows("mention", "nothing like it")).toEqual([]);
  });

  it("does not match on a description", () => {
    // "Drafts release notes" and "Run the service health checks".
    expect(rows("mention", "drafts")).toEqual([]);
    expect(rows("mention", "service")).toEqual([]);
  });

  it("lists skills alone when the harness reports no plugins", () => {
    const items = referenceMenuItems({ kind: "mention", query: "", plugins: [], skills });
    expect(items.map((item) => item.reference.kind)).toEqual(["skill", "skill"]);
  });

  it("is empty when the harness reports neither", () => {
    expect(referenceMenuItems({ kind: "mention", query: "", plugins: [], skills: [] })).toEqual([]);
    expect(REFERENCE_MENU_LABELS.mention).toBe("Plugins and skills");
  });

  it("keeps a plugin and a skill of the same name apart", () => {
    const items = referenceMenuItems({
      kind: "mention",
      query: "",
      plugins: [{ name: "deploy", enabled: true }],
      skills: [{ name: "deploy", path: "/skills/deploy/SKILL.md", enabled: true }],
    });
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.map((item) => referenceToken(item.reference))).toEqual(["@deploy", "$deploy"]);
  });
});

describe("referenceMenuItems for $", () => {
  it("lists enabled skills only, ungrouped", () => {
    const items = rows("skill");
    expect(items.map((item) => item.label)).toEqual(["health-checks", "smoke-tests"]);
    expect(items.every((item) => item.reference.kind === "skill")).toBe(true);
    expect(items.every((item) => item.group === undefined)).toBe(true);
  });

  it("filters by the query", () => {
    expect(rows("skill", "smoke").map((item) => item.label)).toEqual(["smoke-tests"]);
    expect(rows("skill", "formatter")).toEqual([]);
  });

  it("lists no row for a shell variable a description happens to mention", () => {
    const withPath: ReadonlyArray<SkillSummary> = [
      {
        name: "resolver",
        path: "/skills/resolver/SKILL.md",
        description: "Resolve an import PATH or the HOME directory",
        enabled: true,
      },
    ];
    for (const query of ["HOME", "PATH"]) {
      expect(referenceMenuItems({ kind: "skill", query, plugins, skills: withPath })).toEqual([]);
    }
  });

  it("is empty when the harness reports no skills", () => {
    expect(referenceMenuItems({ kind: "skill", query: "", plugins, skills: [] })).toEqual([]);
    expect(REFERENCE_MENU_LABELS.skill).toBe("Skills");
  });
});

const ready = <A>(entries: ReadonlyArray<A>): MenuSource<A> => ({ status: "ready", entries });
const loading: MenuSource<never> = { status: "loading", entries: [] };
const failed: MenuSource<never> = { status: "failed", entries: [] };

describe("referenceMenuEmptyLabel", () => {
  const label = (
    kind: "mention" | "skill",
    query: string,
    sources: { plugins?: MenuSource<PluginSummary>; skills?: MenuSource<SkillSummary> },
  ) =>
    referenceMenuEmptyLabel({
      kind,
      query,
      plugins: sources.plugins ?? ready([]),
      skills: sources.skills ?? ready([]),
    });

  it("says the harness has none only when every list answered empty", () => {
    expect(label("mention", "", {})).toBe("No plugins or skills");
    expect(label("skill", "", {})).toBe("No skills");
    // Only disabled entries: nothing the menu could offer.
    expect(label("skill", "x", { skills: ready([skills[2]!]) })).toBe("No skills");
  });

  it("says nothing matches when a query filtered every entry out", () => {
    expect(label("skill", "HOME", { skills: ready(skills) })).toBe("No skills match");
    expect(label("mention", "zzz", { plugins: ready(plugins) })).toBe("No plugins or skills match");
    expect(label("mention", "zzz", { skills: ready(skills) })).toBe("No plugins or skills match");
  });

  it("says it is loading while a list it shows is still being asked", () => {
    expect(label("skill", "", { skills: loading })).toBe("Loading skills…");
    expect(label("mention", "", { plugins: loading })).toBe("Loading plugins and skills…");
    expect(label("mention", "", { skills: loading })).toBe("Loading plugins and skills…");
    // `$` does not show plugins, so their load does not hold it up.
    expect(label("skill", "", { plugins: loading })).toBe("No skills");
  });

  it("names the list that could not be read", () => {
    expect(label("skill", "", { skills: failed })).toBe("Could not list skills");
    expect(label("mention", "", { plugins: failed })).toBe("Could not list plugins");
    expect(label("mention", "", { plugins: failed, skills: failed })).toBe(
      "Could not list plugins or skills",
    );
    expect(label("skill", "", { plugins: failed })).toBe("No skills");
  });
});

describe("neither menu", () => {
  it("ever lists a file", () => {
    for (const kind of ["mention", "skill"] as const) {
      for (const item of rows(kind)) {
        expect(["plugin", "skill"]).toContain(item.reference.kind);
        expect(item.id.startsWith("file:")).toBe(false);
      }
    }
  });
});

describe("referenceToken", () => {
  it("gives a skill a $ token and a plugin an @ token", () => {
    expect(referenceToken({ kind: "skill", name: "health-checks" })).toBe("$health-checks");
    expect(referenceToken({ kind: "plugin", name: "formatter" })).toBe("@formatter");
  });

  it("gives a skill picked from @ its $ token", () => {
    const skill = rows("mention").find((item) => item.reference.kind === "skill");
    expect(skill && referenceToken(skill.reference)).toBe("$health-checks");
  });
});

describe("sameReference", () => {
  it("matches on kind and name together", () => {
    expect(sameReference({ kind: "skill", name: "a" }, { kind: "skill", name: "a" })).toBe(true);
    expect(sameReference({ kind: "skill", name: "a" }, { kind: "plugin", name: "a" })).toBe(false);
    expect(sameReference({ kind: "skill", name: "a" }, { kind: "skill", name: "b" })).toBe(false);
  });
});
