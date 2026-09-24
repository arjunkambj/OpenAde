/**
 * The `#` file mentions: the live `files.search` behind the menu, the pick
 * that writes `#path ` into the draft and records the path, and the two ways
 * a mention leaves again — its chip's remove button, or its token being edited
 * out of the text.
 *
 * The draft token is `#path`; the mention the turn carries is the bare
 * workspace-relative path, so how a connector phrases it to its harness is the
 * connector's business, not the composer's.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { FileSearchResult } from "@OpenAde/contracts/rpc";
import {
  replaceComposerTrigger,
  retainComposerReferences,
  type ComposerTrigger,
} from "@OpenAde/client-runtime/composerTrigger";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import type { TriggerMenuItem } from "@/components/composer/trigger-menu";
import { useClientRuntime } from "@/lib/client-runtime";
import { File as FileIcon, Folder } from "@honeyicons/react";

/** The draft token a picked file mention stands for. */
const fileMentionToken = (path: string): string => `#${path}`;

const ITEM_PREFIX = "file:";

const mentionItems = (files: ReadonlyArray<FileSearchResult>): ReadonlyArray<TriggerMenuItem> =>
  files.map((file) => ({
    id: `${ITEM_PREFIX}${file.path}`,
    label: file.name,
    description: file.path === file.name ? undefined : file.path,
    icon: file.isDirectory ? Folder : FileIcon,
  }));

export interface FileMentions {
  /** The menu rows; empty unless the open trigger is a `file` one. */
  readonly items: ReadonlyArray<TriggerMenuItem>;
  readonly searching: boolean;
  readonly pick: (item: TriggerMenuItem) => void;
  readonly remove: (path: string) => void;
  /** Drop mentions whose token the next text no longer holds. */
  readonly retain: (nextText: string) => void;
}

export function useFileMentions({
  projectId,
  threadId,
  trigger,
  text,
  setText,
  setMentions,
  setTextAndCaret,
}: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly trigger: ComposerTrigger | null;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly setMentions: React.Dispatch<React.SetStateAction<ReadonlyArray<string>>>;
  readonly setTextAndCaret: (text: string, caret: number) => void;
}): FileMentions {
  const { fileSearchAtom } = useClientRuntime();
  const open = trigger?.kind === "file";

  // Debounce via React — the atom family keys per query, so the deferred value
  // is what actually reaches files.search.
  const deferredQuery = React.useDeferredValue(open ? trigger.query : "");
  const searchResult = useAtomValue(fileSearchAtom(projectId, threadId)(deferredQuery));
  const searchFiles = AsyncResult.isSuccess(searchResult) ? searchResult.value : [];
  const searching = !AsyncResult.isSuccess(searchResult);

  const items = React.useMemo<ReadonlyArray<TriggerMenuItem>>(
    () => (open ? mentionItems(searchFiles) : []),
    [open, searchFiles],
  );

  const pick = (item: TriggerMenuItem) => {
    if (trigger === null) {
      return;
    }
    const path = item.id.slice(ITEM_PREFIX.length);
    const next = replaceComposerTrigger(text, trigger, `${fileMentionToken(path)} `);
    setMentions((current) => (current.includes(path) ? current : [...current, path]));
    setTextAndCaret(next.text, next.cursor);
  };

  const remove = (path: string) => {
    setMentions((current) => current.filter((entry) => entry !== path));
    // Remove the first occurrence of the mention's token from the draft.
    const token = fileMentionToken(path);
    const index = text.indexOf(token);
    if (index !== -1) {
      setText(`${text.slice(0, index)}${text.slice(index + token.length)}`.replace(/  +/g, " "));
    }
  };

  const retain = (nextText: string) =>
    setMentions((current) => retainComposerReferences(current, nextText, fileMentionToken));

  return { items, searching, pick, remove, retain };
}
