/**
 * The `/` popover. Level one lists the built-in commands plus the connector's
 * skills; `model`, `effort` and `mode` open a second level whose pick becomes
 * a `thread.settings.update` patch. Everything the menu can do is expressed as
 * a `SlashAction` so the composer keeps one `onSelect` path.
 *
 * There is deliberately no `/clear`: in the harnesses this menu stands in for
 * that name clears the session context, and no command in the union does that
 * yet. Offering it as a name for "empty the textarea" would silently drop the
 * draft while keeping the context the user meant to drop.
 */

import type { Effort, InteractionMode, RuntimeMode } from "@OpenAde/contracts/enums";
import type { ModelOption, SkillSummary } from "@OpenAde/contracts/rpc";

import { TriggerMenu, type TriggerMenuItem } from "@/components/composer/trigger-menu";
import { Close, Lightning, Play } from "@honeyicons/react";

export type SlashLevel = "root" | "model" | "effort" | "mode";

/** What picking an item means — the composer turns it into a dispatch or a text edit. */
export type SlashAction =
  | { readonly type: "settings"; readonly patch: SlashPatch }
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "clear-draft" }
  | { readonly type: "level"; readonly level: SlashLevel };

export interface SlashPatch {
  readonly model?: string;
  readonly effort?: Effort;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: InteractionMode;
}

export interface SlashMenuItem extends TriggerMenuItem {
  readonly action: SlashAction;
}

const RUNTIME_MODES: ReadonlyArray<{ value: RuntimeMode; label: string; description: string }> = [
  {
    value: "approval-required",
    label: "Ask before acting",
    description: "Prompt for everything that mutates or reaches out",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Edits inside the project run free, shell and web still ask",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Everything except sensitive paths and deny rules",
  },
];

const match = (query: string, ...text: ReadonlyArray<string>) => {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || text.some((part) => part.toLowerCase().includes(needle));
};

/**
 * The items for one menu level, filtered by the trigger query. `efforts` is
 * the ladder the bound model accepts — the composer computes it.
 */
export const slashMenuItems = (input: {
  readonly level: SlashLevel;
  readonly query: string;
  readonly skills: ReadonlyArray<SkillSummary>;
  readonly models: ReadonlyArray<ModelOption>;
  readonly efforts: ReadonlyArray<Effort>;
}): ReadonlyArray<SlashMenuItem> => {
  const { level, query, skills, models, efforts } = input;

  if (level === "model") {
    return models
      .filter((model) => match(query, model.id, model.label, model.family))
      .map((model) => ({
        id: `model:${model.id}`,
        label: model.label,
        description: model.family,
        icon: Close,
        action: { type: "settings", patch: { model: model.id } },
      }));
  }

  if (level === "effort") {
    return efforts
      .filter((effort) => match(query, effort))
      .map((effort) => ({
        id: `effort:${effort}`,
        label: effort,
        icon: Lightning,
        action: { type: "settings", patch: { effort } },
      }));
  }

  if (level === "mode") {
    return RUNTIME_MODES.filter((mode) => match(query, mode.label, mode.value)).map((mode) => ({
      id: `mode:${mode.value}`,
      label: mode.label,
      description: mode.description,
      icon: Close,
      action: { type: "settings", patch: { runtimeMode: mode.value } },
    }));
  }

  const builtinList: ReadonlyArray<SlashMenuItem> = [
    {
      id: "builtin:model",
      label: "/model",
      description: "Switch the response model",
      icon: Close,
      action: { type: "level", level: "model" },
    },
    {
      id: "builtin:effort",
      label: "/effort",
      description: "Switch reasoning effort",
      icon: Lightning,
      action: { type: "level", level: "effort" },
    },
    {
      id: "builtin:mode",
      label: "/mode",
      description: "Switch the runtime permission mode",
      icon: Close,
      action: { type: "level", level: "mode" },
    },
    {
      id: "builtin:plan",
      label: "/plan",
      description: "Plan first — propose instead of executing",
      icon: Close,
      action: { type: "settings", patch: { interactionMode: "plan" } },
    },
    {
      id: "builtin:default",
      label: "/default",
      description: "Back to normal execution",
      icon: Play,
      action: { type: "settings", patch: { interactionMode: "default" } },
    },
    {
      id: "builtin:clear-draft",
      label: "/clear-draft",
      description: "Empty the message you are writing",
      icon: Close,
      action: { type: "clear-draft" },
    },
  ];

  const builtins = builtinList.filter((item) => match(query, item.label, item.description ?? ""));

  const skillItems: ReadonlyArray<SlashMenuItem> = skills
    .filter((skill) => skill.enabled && match(query, skill.name, skill.description ?? ""))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      label: `/${skill.name}`,
      description: skill.description,
      icon: Close,
      action: { type: "insert", text: `/${skill.name} ` },
    }));

  return [...builtins, ...skillItems];
};

export function SlashMenu({
  items,
  activeIndex,
  onSelect,
  onHover,
  level,
}: {
  readonly items: ReadonlyArray<SlashMenuItem>;
  readonly activeIndex: number;
  readonly onSelect: (item: SlashMenuItem) => void;
  readonly onHover: (index: number) => void;
  readonly level: SlashLevel;
}) {
  return (
    <TriggerMenu
      items={items}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onHover={onHover}
      emptyLabel={level === "root" ? "No matching commands" : "No options"}
      label={level === "root" ? "Slash commands" : `Pick a ${level}`}
    />
  );
}
