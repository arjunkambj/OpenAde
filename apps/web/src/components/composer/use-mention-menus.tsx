/**
 * The `#`, `@` and `$` menus as one unit: `#` file mentions
 * (`use-file-mentions`) and `@` / `$` plugin and skill references
 * (`use-reference-mentions`), the rows the open one offers, its pick, and the
 * chips' two ways out. The thread composer and the start screen both write a
 * message that can carry mentions and references, so both mount this; only
 * the thread composer adds the `/` menu beside it.
 *
 * The caller owns the trigger state (`useComposerTrigger`) and the keys:
 * Enter asks `composerEnter` with `open` and `itemCount`, and a pick is
 * `pickAt` on the highlighted row.
 */

import type { ConnectorInstanceId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { TurnReference } from "@poseidon/contracts/runtime";
import type { ComposerTrigger } from "@poseidon/client-runtime/composerTrigger";
import type * as React from "react";

import { TriggerMenu } from "@/components/composer/trigger-menu";
import { useFileMentions } from "@/components/composer/use-file-mentions";
import { useReferenceMentions } from "@/components/composer/use-reference-mentions";

export interface MentionMenus {
  /** A `#`, `@` or `$` menu is open. */
  readonly open: boolean;
  /** How many rows the open menu offers; 0 when none is open. */
  readonly itemCount: number;
  /** Pick the row at `index` of the open menu, if there is one. */
  readonly pickAt: (index: number) => void;
  /** Drop mentions and references whose token the next text no longer holds. */
  readonly retain: (nextText: string) => void;
  readonly removeMention: (path: string) => void;
  readonly removeReference: (reference: TurnReference) => void;
  /** The open menu, or `null` when none of these three is open. */
  readonly menu: React.ReactNode;
}

export function useMentionMenus({
  instanceId,
  projectId,
  threadId,
  trigger,
  activeIndex,
  setActiveIndex,
  text,
  setText,
  setMentions,
  setReferences,
  setTextAndCaret,
}: {
  readonly instanceId: ConnectorInstanceId | null;
  readonly projectId: ProjectId;
  /** The thread whose root `#` searches; `null` searches the project's folder. */
  readonly threadId: ThreadId | null;
  readonly trigger: ComposerTrigger | null;
  readonly activeIndex: number;
  readonly setActiveIndex: (index: number) => void;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly setMentions: React.Dispatch<React.SetStateAction<ReadonlyArray<string>>>;
  readonly setReferences: React.Dispatch<React.SetStateAction<ReadonlyArray<TurnReference>>>;
  readonly setTextAndCaret: (text: string, caret: number) => void;
}): MentionMenus {
  const files = useFileMentions({
    projectId,
    threadId,
    trigger,
    text,
    setText,
    setMentions,
    setTextAndCaret,
  });
  const references = useReferenceMentions({
    instanceId,
    projectId,
    trigger,
    text,
    setText,
    setReferences,
    setTextAndCaret,
  });
  const fileOpen = trigger?.kind === "file";
  const referenceOpen = trigger?.kind === "mention" || trigger?.kind === "skill";

  const menu = fileOpen ? (
    <TriggerMenu
      items={files.items}
      activeIndex={activeIndex}
      onSelect={files.pick}
      onHover={setActiveIndex}
      emptyLabel={files.emptyLabel}
      label="File mentions"
    />
  ) : referenceOpen ? (
    <TriggerMenu
      items={references.items}
      activeIndex={activeIndex}
      onSelect={references.pick}
      onHover={setActiveIndex}
      emptyLabel={references.emptyLabel}
      label={references.label}
    />
  ) : null;

  return {
    open: fileOpen || referenceOpen,
    itemCount: fileOpen ? files.items.length : referenceOpen ? references.items.length : 0,
    pickAt: (index) => (fileOpen ? files.pickAt(index) : references.pickAt(index)),
    retain: (nextText) => {
      files.retain(nextText);
      references.retain(nextText);
    },
    removeMention: files.remove,
    removeReference: references.remove,
    menu,
  };
}
