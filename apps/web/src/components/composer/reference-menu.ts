/**
 * The rows of the `@` and `$` menus. `@` lists the thread instance's enabled
 * plugins under "Plugins", then its enabled skills under "Skills"; `$` lists
 * the skills alone. Neither lists files — those are `#`.
 *
 * Each row carries the `TurnReference` a pick adds to the draft, and every
 * reference has exactly one draft token: `@name` for a plugin, `$name` for a
 * skill, even when the skill was picked from the `@` menu. Chips are kept in
 * step with the text by whole-token match, so a plugin and a skill that share
 * a name must not share a token.
 *
 * Rows match the query on their name alone, never the description. `$` also
 * opens on shell variables (`$HOME`, `$PATH`), and a menu with a row owns
 * Enter, so a skill whose description merely mentions "path" would otherwise
 * swallow the send.
 */

import type { PluginSummary, SkillSummary } from "@OpenAde/contracts/connectors";
import type { TurnReference } from "@OpenAde/contracts/runtime";

import type { MenuSource } from "@/components/composer/menu-source";
import { matchesQuery, type TriggerMenuItem } from "@/components/composer/trigger-menu";
import { Puzzle, Sparkles } from "@honeyicons/react";

/** The two triggers this menu serves: `@` (`mention`) and `$` (`skill`). */
export type ReferenceMenuKind = "mention" | "skill";

export interface ReferenceMenuItem extends TriggerMenuItem {
  readonly reference: TurnReference;
}

/** The draft token a picked reference stands for. */
export const referenceToken = (reference: TurnReference): string =>
  `${reference.kind === "skill" ? "$" : "@"}${reference.name}`;

/** Same kind and name — a second pick of it adds no second chip. */
export const sameReference = (a: TurnReference, b: TurnReference): boolean =>
  a.kind === b.kind && a.name === b.name;

/** What each menu is called, for its listbox. */
export const REFERENCE_MENU_LABELS: Readonly<Record<ReferenceMenuKind, string>> = {
  mention: "Plugins and skills",
  skill: "Skills",
};

/**
 * What the menu says when it has no rows. "No skills" claims the harness has
 * none, so it is said only when that is what the lists answered: while one is
 * still being asked the menu says so, a list that could not be read is named,
 * and a query that filtered every entry out says nothing matches.
 */
export const referenceMenuEmptyLabel = (input: {
  readonly kind: ReferenceMenuKind;
  readonly query: string;
  readonly plugins: MenuSource<PluginSummary>;
  readonly skills: MenuSource<SkillSummary>;
}): string => {
  const { kind, query, plugins, skills } = input;
  const sources: ReadonlyArray<readonly [string, MenuSource<{ readonly enabled: boolean }>]> =
    kind === "skill"
      ? [["skills", skills]]
      : [
          ["plugins", plugins],
          ["skills", skills],
        ];
  const nouns = kind === "skill" ? "skills" : "plugins or skills";
  if (sources.some(([, source]) => source.status === "loading")) {
    return kind === "skill" ? "Loading skills…" : "Loading plugins and skills…";
  }
  const failed = sources.filter(([, source]) => source.status === "failed");
  if (failed.length > 0) {
    return `Could not list ${failed.map(([noun]) => noun).join(" or ")}`;
  }
  const listsAny = sources.some(([, source]) => source.entries.some((entry) => entry.enabled));
  return query.trim().length > 0 && listsAny ? `No ${nouns} match` : `No ${nouns}`;
};

const listed = <Entry extends { readonly name: string; readonly enabled: boolean }>(
  entries: ReadonlyArray<Entry>,
  query: string,
): ReadonlyArray<Entry> =>
  entries.filter((entry) => entry.enabled && matchesQuery(query, entry.name));

const skillItems = (
  skills: ReadonlyArray<SkillSummary>,
  query: string,
  group: string | undefined,
): ReadonlyArray<ReferenceMenuItem> =>
  listed(skills, query).map((skill) => ({
    id: `skill:${skill.name}`,
    label: skill.name,
    description: skill.description,
    icon: Sparkles,
    group,
    reference: { kind: "skill", name: skill.name },
  }));

/** The rows for one open `@` or `$` trigger, filtered by its query. */
export const referenceMenuItems = (input: {
  readonly kind: ReferenceMenuKind;
  readonly query: string;
  readonly plugins: ReadonlyArray<PluginSummary>;
  readonly skills: ReadonlyArray<SkillSummary>;
}): ReadonlyArray<ReferenceMenuItem> => {
  const { kind, query, plugins, skills } = input;
  if (kind === "skill") {
    return skillItems(skills, query, undefined);
  }
  const pluginItems = listed(plugins, query).map((plugin): ReferenceMenuItem => ({
    id: `plugin:${plugin.name}`,
    label: plugin.name,
    description: plugin.description,
    icon: Puzzle,
    group: "Plugins",
    reference: { kind: "plugin", name: plugin.name },
  }));
  return [...pluginItems, ...skillItems(skills, query, "Skills")];
};
