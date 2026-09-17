import { describe, expect, it } from "vitest";

import {
  scopeLabel,
  selectedOptionLabel,
  USER_SCOPE,
  USER_SCOPE_LABEL,
  type LabelledOption,
} from "./select-label";

const models: ReadonlyArray<LabelledOption> = [
  { value: "acme/big-model-4.8", label: "Harness · Big Model 4.8" },
  { value: "acme/small-model", label: "Harness · Small Model" },
];

describe("selectedOptionLabel", () => {
  it("shows the option's label, not the value the picker holds", () => {
    // The regression: the settings model picker read the raw model id.
    expect(selectedOptionLabel(models, "acme/big-model-4.8")).toBe("Harness · Big Model 4.8");
  });

  it("falls back to the value while the options are still loading", () => {
    expect(selectedOptionLabel([], "acme/big-model-4.8")).toBe("acme/big-model-4.8");
  });

  it("answers null when nothing is selected, so the placeholder shows", () => {
    expect(selectedOptionLabel(models, null)).toBeNull();
    expect(selectedOptionLabel(models, undefined)).toBeNull();
    expect(selectedOptionLabel(models, "")).toBeNull();
    expect(selectedOptionLabel(models, 7)).toBeNull();
  });
});

describe("scopeLabel", () => {
  const projects = [
    { projectId: "p1", name: "my-app" },
    { projectId: "p2", name: "other" },
  ];

  it("never leaks the sentinel the select holds for user scope", () => {
    expect(scopeLabel(USER_SCOPE, projects)).toBe(USER_SCOPE_LABEL);
    expect(scopeLabel(null, projects)).toBe(USER_SCOPE_LABEL);
  });

  it("names the picked project", () => {
    expect(scopeLabel("p2", projects)).toBe("other");
  });

  it("falls back to user scope for a project that is gone", () => {
    expect(scopeLabel("p9", projects)).toBe(USER_SCOPE_LABEL);
  });
});
