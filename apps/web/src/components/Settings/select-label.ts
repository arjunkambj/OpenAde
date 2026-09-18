/**
 * What a closed `<Select>` trigger should read.
 *
 * base-ui's `Select.Value` renders the raw *value* unless it is given a
 * formatter: the items live in a portal that is unmounted while the popup is
 * closed, so there is no value → label registry to consult. Every picker whose
 * value differs from its label was therefore showing the value — the settings
 * model picker read a bare provider-qualified model id, and the MCP and Skills
 * scope pickers read the `__user__` sentinel that exists only because a
 * `Select` cannot hold `null`.
 *
 * These are the formatters those call sites pass, kept here so the sentinel and
 * the fallback rule have one definition and a test.
 */

/** A picker option, as both `SchemaForm` and the scope pickers shape them. */
export interface LabelledOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The label for `value`, or the value itself when no option carries it — the
 * model list arrives asynchronously, and the id is a truthful stand-in until it
 * does. `null` means nothing is selected, so the placeholder should show.
 */
export const selectedOptionLabel = (
  options: ReadonlyArray<LabelledOption>,
  value: unknown,
): string | null => {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  return options.find((option) => option.value === value)?.label ?? value;
};

/**
 * Where an MCP server's entry is written. The options live here rather than
 * inline in the dialog so the items and the closed trigger read from one list:
 * the trigger was showing the bare `user` / `project` value while the items
 * said "User" and "Project".
 */
export const MCP_SCOPE_OPTIONS: ReadonlyArray<LabelledOption> = [
  { value: "user", label: "User" },
  { value: "project", label: "Project" },
];

/**
 * The stand-in a scope `<Select>` uses for "user scope", because the real value
 * there is `null` and a select item cannot hold one.
 */
export const USER_SCOPE = "__user__";

export const USER_SCOPE_LABEL = "User scope";

/** The scope picker's trigger text: the project's name, or "User scope". */
export const scopeLabel = (
  value: unknown,
  projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>,
): string => {
  if (typeof value !== "string" || value === USER_SCOPE) {
    return USER_SCOPE_LABEL;
  }
  return projects.find((project) => project.projectId === value)?.name ?? USER_SCOPE_LABEL;
};
