/**
 * The composer. Textarea with `@` file mentions (live `files.search`), a `/`
 * command popover, file attach, the queued-message strip, and the
 * interaction-card slot — one card at a time, above the input.
 *
 * Keys: Enter sends (queues while a turn runs — the decider rejects a second
 * turn, so "send" on a busy thread means queue) unless an open trigger menu has
 * a row to pick, which `composer-keys` decides; Shift+Enter newline,
 * Cmd+Enter queues explicitly, Escape closes an open trigger menu first and
 * otherwise reaches the `thread.interrupt` binding this component registers —
 * the toolbar's Stop button is the same call with a mouse. State reads
 * `threadDetailAtom`; mutations go through `dispatchAtom`; cards close on
 * their resolved events — nothing here clears them locally.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { cn } from "@OpenAde/ui/lib/utils";
import type { Effort } from "@OpenAde/contracts/enums";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { FileSearchResult } from "@OpenAde/contracts/rpc";
import {
  detectComposerTrigger,
  replaceComposerTrigger,
  retainComposerReferences,
} from "@OpenAde/client-runtime/composerTrigger";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { HeaderControls } from "@/components/header-controls";
import { useProjects } from "@/state/hooks";
import { ComposerSurface, composerInputClassName } from "@/components/composer/composer-surface";
import { ComposerChips } from "@/components/composer/composer-chips";
import { composerEnter } from "@/components/composer/composer-keys";
import { ComposerToolbar } from "@/components/composer/composer-toolbar";
import { PendingCard } from "@/components/composer/pending-card";
import { QueueStrip } from "@/components/composer/queue-strip";
import { SlashMenu, slashMenuItems, type SlashMenuItem } from "@/components/composer/slash-menu";
import { TriggerMenu, type TriggerMenuItem } from "@/components/composer/trigger-menu";
import { useAttachments } from "@/components/composer/use-attachments";
import { useComposerTrigger } from "@/components/composer/use-composer-trigger";
import { useInterrupt } from "@/components/composer/use-interrupt";
import { useSendDraft } from "@/components/composer/use-send-draft";
import { useClientRuntime } from "@/lib/client-runtime";
import { routedConnectorInstanceId } from "@/lib/connector-routing";
import { turnInFlight } from "@/lib/turn";
import { useKeybindingCommand, useKeybindingFlag } from "@/lib/shortcuts";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { useComposerDraft } from "@/state/ui";
import { File as FileIcon, Folder } from "@honeyicons/react";

const ALL_EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"];

const mentionItems = (files: ReadonlyArray<FileSearchResult>): ReadonlyArray<TriggerMenuItem> =>
  files.map((file) => ({
    id: `file:${file.path}`,
    label: file.name,
    description: file.path === file.name ? undefined : file.path,
    icon: file.isDirectory ? Folder : FileIcon,
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
  const project = useProjects().find((entry) => entry.projectId === projectId);
  const {
    threadDetailAtom,
    dispatchAtom,
    fileSearchAtom,
    connectorsAtom,
    connectorModelsAtom,
    skillsAtom,
  } = useClientRuntime();
  const docResult = useAtomValue(threadDetailAtom(threadId));
  const doc = AsyncResult.isSuccess(docResult) ? docResult.value : null;
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  // Not `doc.session` alone: a thread binds one on its first turn, and until
  // then `/model` and `/effort` had nothing to offer — see
  // `@/lib/connector-routing`.
  const connectorsResult = useAtomValue(connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const instanceId = routedConnectorInstanceId(doc?.session?.connectorInstanceId, connectors);
  const modelsResult = useAtomValue(connectorModelsAtom(instanceId));
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];
  const skillsResult = useAtomValue(skillsAtom(projectId));
  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value : [];

  // The draft lives in a per-thread renderer atom, not in this component: the
  // composer unmounts on every thread switch (the next thread's detail atom
  // starts at `Initial`), and with it went the text, the mentions and any
  // pasted image — unsent, unsaved and unwarned. See `@/state/ui`.
  const { text, mentions, files, setText, setMentions, setFiles } = useComposerDraft(threadId);
  const [error, setError] = React.useState<string | null>(null);
  const attachments = useAttachments(threadId, files, setFiles);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const {
    trigger,
    activeIndex,
    slashLevel,
    setActiveIndex,
    setLevel: setSlashLevel,
    open: openTrigger,
    close: closeMenu,
    refresh: refreshTrigger,
  } = useComposerTrigger(textareaRef);

  // `turnInFlight`, not `currentTurnId`: the projection fills the id on
  // thread.turn.started, one event after status goes to "running" on
  // thread.turn.requested. In that window this composer would have shown
  // "Send" with no Stop button while a turn was already under way — which is
  // exactly when a user reaches for Escape — and a message sent there would
  // have gone out unqueued and been rejected as "a turn is already running".
  // The header and the timeline already read the shared helper.
  const running = doc !== null && turnInFlight(doc);
  const { interrupting, interrupt } = useInterrupt(threadId, running, setError);
  const { sending, send: sendDraft } = useSendDraft(threadId, attachments, setError, () => {
    setText("");
    setMentions([]);
  });

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
        return;
      case "insert":
        if (trigger !== null) {
          const next = replaceComposerTrigger(text, trigger, item.action.text);
          setTextAndCaret(next.text, next.cursor);
        }
        return;
      case "clear-draft":
        setText("");
        setMentions([]);
        attachments.clear();
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

  /** The draft is the composer's; the upload and the dispatch are the hook's. */
  const send = (queue: boolean) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 && attachments.files.length === 0) {
      return;
    }
    sendDraft({ text: trimmed, mentions, queued: queue || running });
  };

  const focusInput = React.useCallback(() => textareaRef.current?.focus(), []);

  useKeybindingFlag("threadRunning", running);
  useKeybindingCommand("thread.interrupt", interrupt);
  // Cmd+Enter inside the textarea is handled by onKeyDown; reaching here means
  // focus is elsewhere, so the useful thing to do is put it back.
  useKeybindingCommand("composer.queue", focusInput);

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
    if (event.key === "Enter") {
      const action = composerEnter({
        triggerOpen: trigger !== null,
        menuItemCount,
        shiftKey: event.shiftKey,
        composing: event.nativeEvent.isComposing,
      });
      if (action === "insert") {
        return;
      }
      event.preventDefault();
      if (action === "send") {
        // An open menu with nothing in it does not hold the message hostage:
        // close it and send, rather than swallowing the key.
        closeMenu();
        send(event.metaKey || event.ctrlKey);
        return;
      }
      const index = Math.min(activeIndex, Math.max(0, menuItemCount - 1));
      if (trigger?.kind === "at") {
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
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (slashLevel !== "root") {
          setSlashLevel("root");
        } else {
          closeMenu();
        }
        return;
      }
    }
  };

  const canSend = text.trim().length > 0 || attachments.files.length > 0;
  /** One line under the input: a dispatch error, else what was refused. */
  const notice = error ?? attachments.rejected;

  return (
    <div className={cn("flex w-full min-w-0 max-w-[760px] shrink-0 flex-col gap-2", className)}>
      <PendingCard threadId={threadId} doc={doc} />
      {doc === null ? null : <QueueStrip threadId={threadId} queue={doc.queue} />}
      <ComposerSurface
        dragging={attachments.dragging}
        context={
          project ? (
            <>
              <Folder size={16} className="shrink-0" />
              <span className="truncate" title={project.workspaceRoot}>
                {project.name}
              </span>
            </>
          ) : undefined
        }
        onSubmit={(event) => event.preventDefault()}
        {...attachments.dropHandlers}
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
          files={attachments.files}
          onRemoveMention={removeMention}
          onRemoveFile={attachments.removeAt}
        />
        <textarea
          ref={textareaRef}
          aria-label="Message"
          data-context="composer"
          rows={2}
          value={text}
          onChange={onChangeText}
          onKeyDown={onKeyDown}
          onPaste={attachments.onPaste}
          onSelect={refreshTrigger}
          onClick={refreshTrigger}
          className={composerInputClassName}
        />
        <ComposerToolbar
          settings={<HeaderControls threadId={threadId} className="min-w-0 flex-1" />}
          running={running}
          canSend={canSend}
          contextUsed={doc?.context?.used}
          contextLimit={doc?.context?.limit}
          interrupting={interrupting}
          sending={sending}
          filesKey={attachments.files.length}
          onFilesPicked={attachments.add}
          onSend={() => send(running)}
          onInterrupt={interrupt}
        />
        {notice === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {notice}
          </p>
        )}
      </ComposerSurface>
    </div>
  );
}
