/**
 * The composer. Textarea with `@` file mentions (live `files.search`), a `/`
 * command popover, file attach, the queued-message strip, and the
 * interaction-card slot — one card at a time, above the input.
 *
 * Keys: Enter sends (queues while a turn runs — the decider rejects a second
 * turn, so "send" on a busy thread means queue), Shift+Enter newline,
 * Cmd+Enter queues explicitly, Escape closes an open trigger menu first and
 * otherwise reaches the global `thread.interrupt` binding. State reads
 * `threadDetailAtom`; mutations go through `dispatchAtom`; cards close on
 * their resolved events — nothing here clears them locally.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { cn } from "@OpenAde/ui/lib/utils";
import type { Effort } from "@OpenAde/contracts/enums";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { Attachment } from "@OpenAde/contracts/orchestration";
import type { FileSearchResult } from "@OpenAde/contracts/rpc";
import {
  detectComposerTrigger,
  replaceComposerTrigger,
  retainComposerReferences,
  type ComposerTrigger,
} from "@OpenAde/client-runtime/composerTrigger";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { ComposerChips } from "@/components/composer/composer-chips";
import { ComposerHints } from "@/components/composer/composer-hints";
import { ComposerToolbar } from "@/components/composer/composer-toolbar";
import { PendingCard } from "@/components/composer/pending-card";
import { QueueStrip } from "@/components/composer/queue-strip";
import {
  SlashMenu,
  slashMenuItems,
  type SlashLevel,
  type SlashMenuItem,
} from "@/components/composer/slash-menu";
import { TriggerMenu, type TriggerMenuItem } from "@/components/composer/trigger-menu";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";

const ALL_EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"];

const mentionItems = (files: ReadonlyArray<FileSearchResult>): ReadonlyArray<TriggerMenuItem> =>
  files.map((file) => ({
    id: `file:${file.path}`,
    label: file.name,
    description: file.path === file.name ? undefined : file.path,
    icon: file.isDirectory ? "hugeicons:folder-01" : "hugeicons:file-02",
  }));

/** The level-2 slash query: everything after the command word. */
const subQuery = (query: string): string => {
  const space = query.search(/\s/u);
  return space === -1 ? "" : query.slice(space + 1);
};

export function Composer({
  threadId,
  projectId,
  className,
}: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly className?: string;
}) {
  const { threadDetailAtom, dispatchAtom, fileSearchAtom, connectorModelsAtom, skillsAtom } =
    useClientRuntime();
  const docResult = useAtomValue(threadDetailAtom(threadId));
  const doc = AsyncResult.isSuccess(docResult) ? docResult.value : null;
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  const instanceId = doc?.session?.connectorInstanceId ?? null;
  const modelsResult = useAtomValue(connectorModelsAtom(instanceId));
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];
  const skillsResult = useAtomValue(skillsAtom(projectId));
  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value : [];

  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<ReadonlyArray<File>>([]);
  const [mentions, setMentions] = React.useState<ReadonlyArray<string>>([]);
  const [trigger, setTrigger] = React.useState<ComposerTrigger | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [slashLevel, setSlashLevel] = React.useState<SlashLevel>("root");
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const running = doc !== null && doc.currentTurnId !== null;

  // Debounce via React — the atom family keys per query, so the deferred value
  // is what actually reaches files.search.
  const atQuery = trigger?.kind === "at" ? trigger.query : "";
  const deferredQuery = React.useDeferredValue(atQuery);
  const searchResult = useAtomValue(fileSearchAtom(projectId)(deferredQuery));
  const searchFiles = AsyncResult.isSuccess(searchResult) ? searchResult.value : [];
  const searching = !AsyncResult.isSuccess(searchResult);

  const atItems = React.useMemo<ReadonlyArray<TriggerMenuItem>>(
    () => (trigger?.kind === "at" ? mentionItems(searchFiles) : []),
    [trigger?.kind, searchFiles],
  );
  const slashItems = React.useMemo<ReadonlyArray<SlashMenuItem>>(() => {
    if (trigger?.kind !== "slash") {
      return [];
    }
    const currentModel = models.find((model) => model.id === doc?.settings.model);
    return slashMenuItems({
      level: slashLevel,
      query: slashLevel === "root" ? trigger.query : subQuery(trigger.query),
      skills,
      models,
      efforts: currentModel?.efforts ?? ALL_EFFORTS,
    });
  }, [trigger, slashLevel, skills, models, doc?.settings.model]);
  const menuItemCount = trigger?.kind === "at" ? atItems.length : slashItems.length;

  const closeMenu = React.useCallback(() => {
    setTrigger(null);
    setSlashLevel("root");
    setActiveIndex(0);
  }, []);

  /** Store the detected trigger; a kind change resets level and highlight. */
  const openTrigger = React.useCallback((next: ComposerTrigger | null) => {
    setTrigger((current) => {
      if (next === null || current === null || next.kind !== current.kind) {
        setSlashLevel("root");
        setActiveIndex(0);
      }
      return next;
    });
  }, []);

  const refreshTrigger = React.useCallback(() => {
    const el = textareaRef.current;
    if (el !== null) {
      openTrigger(detectComposerTrigger(el.value, el.selectionStart ?? el.value.length));
    }
  }, [openTrigger]);

  const setTextAndCaret = (nextText: string, caret: number) => {
    setText(nextText);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
      refreshTrigger();
    });
  };

  const pickMention = (item: TriggerMenuItem) => {
    if (trigger === null) {
      return;
    }
    const path = item.id.slice("file:".length);
    const next = replaceComposerTrigger(text, trigger, `@${path} `);
    setMentions((current) => (current.includes(path) ? current : [...current, path]));
    setTextAndCaret(next.text, next.cursor);
  };

  const applySlash = (item: SlashMenuItem) => {
    switch (item.action.type) {
      case "level":
        setSlashLevel(item.action.level);
        setActiveIndex(0);
        return;
      case "insert":
        if (trigger !== null) {
          const next = replaceComposerTrigger(text, trigger, item.action.text);
          setTextAndCaret(next.text, next.cursor);
        }
        return;
      case "clear":
        setText("");
        setMentions([]);
        closeMenu();
        return;
      case "settings":
        closeMenu();
        setText((current) =>
          trigger === null ? current : replaceComposerTrigger(current, trigger, "").text.trim(),
        );
        void dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.settings.update",
          threadId,
          ...item.action.patch,
        }).then(
          (receipt) => setError(receiptError(receipt, "the server rejected the setting")),
          () => setError(DISPATCH_UNREACHABLE),
        );
        return;
    }
  };

  const send = (queue: boolean) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 && files.length === 0) {
      return;
    }
    const attachments: ReadonlyArray<Attachment> = files.map((file) => ({
      path: file.name,
      mime: file.type === "" ? undefined : file.type,
    }));
    void dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.turn.start",
      threadId,
      text: trimmed,
      attachments,
      mentions: [...mentions],
      queued: queue || running,
    }).then(
      (receipt) => {
        const rejected = receiptError(receipt, "the server rejected the message");
        if (rejected === null) {
          setText("");
          setMentions([]);
          setFiles([]);
        }
        setError(rejected);
      },
      () => setError(DISPATCH_UNREACHABLE),
    );
  };

  const onChangeText = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setText(next);
    setMentions((current) => retainComposerReferences(current, next, (path) => `@${path}`));
    const caret = event.target.selectionStart ?? next.length;
    openTrigger(detectComposerTrigger(next, caret));
  };

  const removeMention = (path: string) => {
    setMentions((current) => current.filter((entry) => entry !== path));
    // Remove the first whole-token occurrence of `@path` from the draft.
    const token = `@${path}`;
    const index = text.indexOf(token);
    if (index !== -1) {
      setText(`${text.slice(0, index)}${text.slice(index + token.length)}`.replace(/  +/g, " "));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger !== null) {
      if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % Math.max(1, menuItemCount));
        return;
      }
      if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + menuItemCount) % Math.max(1, menuItemCount));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const index = Math.min(activeIndex, Math.max(0, menuItemCount - 1));
        if (trigger.kind === "at") {
          const item = atItems[index];
          if (item !== undefined) {
            pickMention(item);
          }
        } else {
          const item = slashItems[index];
          if (item !== undefined) {
            applySlash(item);
          }
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (slashLevel !== "root") {
          setSlashLevel("root");
          setActiveIndex(0);
        } else {
          closeMenu();
        }
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(event.metaKey || event.ctrlKey);
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length > 0) {
      event.preventDefault();
      setFiles((current) => [...current, ...pasted]);
    }
  };

  const onDrop = (event: React.DragEvent) => {
    if (event.dataTransfer.files.length > 0) {
      event.preventDefault();
      setFiles((current) => [...current, ...event.dataTransfer.files]);
    }
  };

  const canSend = text.trim().length > 0 || files.length > 0;

  return (
    <div className={cn("flex w-full min-w-0 max-w-[760px] shrink-0 flex-col gap-2", className)}>
      <PendingCard threadId={threadId} doc={doc} />
      {doc === null ? null : <QueueStrip queue={doc.queue} />}
      <form
        className="relative flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3"
        onSubmit={(event) => event.preventDefault()}
        onDrop={onDrop}
        aria-label="Message composer"
      >
        {trigger !== null ? (
          trigger.kind === "at" ? (
            <TriggerMenu
              items={atItems}
              activeIndex={activeIndex}
              onSelect={pickMention}
              onHover={setActiveIndex}
              emptyLabel="No files match"
              loading={searching}
              label="File mentions"
            />
          ) : (
            <SlashMenu
              items={slashItems}
              activeIndex={activeIndex}
              onSelect={applySlash}
              onHover={setActiveIndex}
              level={slashLevel}
            />
          )
        ) : null}
        <ComposerChips
          mentions={mentions}
          files={files}
          onRemoveMention={removeMention}
          onRemoveFile={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
        />
        <textarea
          ref={textareaRef}
          aria-label="Message"
          data-context="composer"
          placeholder="Ask anything — @ for files, / for commands"
          rows={2}
          value={text}
          onChange={onChangeText}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={refreshTrigger}
          onClick={refreshTrigger}
          className="field-sizing-content block max-h-48 min-h-10 w-full resize-none bg-transparent text-sm leading-normal text-foreground outline-none placeholder:text-muted-foreground"
        />
        <ComposerToolbar
          running={running}
          canSend={canSend}
          contextUsed={doc?.context?.used}
          contextLimit={doc?.context?.limit}
          filesKey={files.length}
          onFilesPicked={(picked) => setFiles((current) => [...current, ...picked])}
          onSend={() => send(running)}
        />
        {error === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </form>
      <ComposerHints />
    </div>
  );
}
