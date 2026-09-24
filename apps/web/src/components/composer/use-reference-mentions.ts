/**
 * The `@` and `$` references: the thread instance's plugins and skills behind
 * the two menus, the pick that writes the reference's token into the draft
 * and records it, and the two ways a reference leaves again — its chip's
 * remove button, or its token being edited out of the text.
 *
 * An instance whose harness has no plugins answers `[]` (see `pluginsAtom`),
 * so `@` then lists skills alone; one with neither shows the empty state.
 * How a reference reaches the harness is the connector's business: the turn
 * carries only `{ kind, name }`.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorInstanceId, ProjectId } from "@OpenAde/contracts/ids";
import type { TurnReference } from "@OpenAde/contracts/runtime";
import {
  removeComposerToken,
  replaceComposerTrigger,
  retainComposerReferences,
  type ComposerTrigger,
} from "@OpenAde/client-runtime/composerTrigger";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  REFERENCE_MENU_LABELS,
  referenceMenuItems,
  referenceToken,
  sameReference,
  type ReferenceMenuItem,
} from "@/components/composer/reference-menu";
import { useClientRuntime } from "@/lib/client-runtime";

export interface ReferenceMentions {
  /** The menu rows; empty unless the open trigger is `@` or `$`. */
  readonly items: ReadonlyArray<ReferenceMenuItem>;
  readonly emptyLabel: string;
  readonly label: string;
  readonly pick: (item: ReferenceMenuItem) => void;
  /** Pick the row at `index`, if there is one — Enter on the highlighted row. */
  readonly pickAt: (index: number) => void;
  readonly remove: (reference: TurnReference) => void;
  /** Drop references whose token the next text no longer holds. */
  readonly retain: (nextText: string) => void;
}

export function useReferenceMentions({
  instanceId,
  projectId,
  trigger,
  text,
  setText,
  setReferences,
  setTextAndCaret,
}: {
  readonly instanceId: ConnectorInstanceId | null;
  readonly projectId: ProjectId;
  readonly trigger: ComposerTrigger | null;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly setReferences: React.Dispatch<React.SetStateAction<ReadonlyArray<TurnReference>>>;
  readonly setTextAndCaret: (text: string, caret: number) => void;
}): ReferenceMentions {
  const { pluginsAtom, skillsAtom } = useClientRuntime();
  const pluginsResult = useAtomValue(pluginsAtom(instanceId)(projectId));
  const skillsResult = useAtomValue(skillsAtom(instanceId)(projectId));
  const plugins = AsyncResult.isSuccess(pluginsResult) ? pluginsResult.value : [];
  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value : [];
  const kind = trigger?.kind === "mention" || trigger?.kind === "skill" ? trigger.kind : null;
  const query = trigger?.query ?? "";

  const items = React.useMemo<ReadonlyArray<ReferenceMenuItem>>(
    () => (kind === null ? [] : referenceMenuItems({ kind, query, plugins, skills })),
    [kind, query, plugins, skills],
  );
  const labels = REFERENCE_MENU_LABELS[kind ?? "mention"];

  const pick = (item: ReferenceMenuItem) => {
    if (trigger === null) {
      return;
    }
    const next = replaceComposerTrigger(text, trigger, `${referenceToken(item.reference)} `);
    setReferences((current) =>
      current.some((entry) => sameReference(entry, item.reference))
        ? current
        : [...current, item.reference],
    );
    setTextAndCaret(next.text, next.cursor);
  };

  const pickAt = (index: number) => {
    const item = items[index];
    if (item !== undefined) {
      pick(item);
    }
  };

  const remove = (reference: TurnReference) => {
    setReferences((current) => current.filter((entry) => !sameReference(entry, reference)));
    setText(removeComposerToken(text, referenceToken(reference)));
  };

  const retain = (nextText: string) =>
    setReferences((current) => retainComposerReferences(current, nextText, referenceToken));

  return { items, emptyLabel: labels.empty, label: labels.label, pick, pickAt, remove, retain };
}
