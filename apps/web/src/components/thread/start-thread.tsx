/**
 * What `/` shows: laid out like an empty thread — the greeting in the middle
 * and a composer pinned underneath, with the project it runs in picked beside
 * the send button.
 *
 * There is no such thing as a thread without a project, so the picker always
 * holds one — the project a thread was last started in (`useLastProject`),
 * else the first. Sending creates the thread through `useCreateThread`, sends
 * the message as its first turn, and lands on it. The id is minted when this
 * screen mounts and the draft is keyed by it, so a first message that fails
 * after the thread exists is still in the thread's own composer when the user
 * gets there.
 *
 * The runtime modes offered and whether attaching is allowed come from the
 * capabilities of the connector the new thread would route to.
 *
 * With no server it says so. A fresh install lands here with no projects, so
 * the empty state carries the same Add project dialog the sidebar does —
 * without it the screen would be an input with nowhere to send it.
 */

import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAppAtoms } from "@/lib/app-runtime";
import { ComposerSurface, composerInputClassName } from "@/components/composer/composer-surface";
import { ComposerToolbar } from "@/components/composer/composer-toolbar";
import { ThreadSettingsControls } from "@/components/header-controls";
import { makeThreadId, type ProjectId } from "@OpenAde/contracts/ids";
import type { ProjectSummary, ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";

import { ComposerChips } from "@/components/composer/composer-chips";
import { useAttachments } from "@/components/composer/use-attachments";
import { useSendDraft } from "@/components/composer/use-send-draft";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import { ThreadGreeting } from "@/components/thread/thread-greeting";
import { attachmentRefusal } from "@/lib/attachment-support";
import { routedCapabilities } from "@/lib/connector-routing";
import { runtimeModeOptions } from "@/lib/runtime-modes";
import { useCreateThread } from "@/lib/use-create-thread";
import { useConnectionState, useProjects } from "@/state/hooks";
import { useComposerDraft, useLastProject } from "@/state/ui";
import { Folder } from "@honeyicons/react";

function ProjectPicker({
  projects,
  value,
  onPick,
}: {
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly value: ProjectId;
  readonly onPick: (projectId: ProjectId) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const project = projects.find((entry) => entry.projectId === next);
        if (project !== undefined) {
          onPick(project.projectId);
        }
      }}
      items={projects.map((project) => ({ value: project.projectId, label: project.name }))}
    >
      <SelectTrigger aria-label="Project" size="sm" variant="composer" className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-56">
        <SelectGroup>
          {projects.map((project) => (
            <SelectItem key={project.projectId} value={project.projectId}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{project.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function StartComposer({
  projects,
  project,
  onPickProject,
}: {
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly project: ProjectSummary | undefined;
  readonly onPickProject: (projectId: ProjectId) => void;
}) {
  const navigate = useNavigate();
  const { create, pending } = useCreateThread();

  const [threadId] = React.useState(makeThreadId);
  const { text, files, setText, setMentions, setFiles } = useComposerDraft(threadId);
  const atoms = useAppAtoms();
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const capabilities = routedCapabilities(null, connectors);
  const attachRefusal = attachmentRefusal(capabilities);
  const attachments = useAttachments(threadId, files, setFiles, attachRefusal);
  const defaultsResult = useAtomValue(atoms.settingsAtom);
  const modelsResult = useAtomValue(atoms.allModelsAtom);
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];
  const defaults = AsyncResult.isSuccess(defaultsResult) ? defaultsResult.value?.defaults : null;
  const [settings, setSettings] = React.useState<ThreadSettingsPatch>({});
  const initialModel = defaults?.model ?? models[0]?.id;
  const shownSettings: ThreadSettingsPatch = {
    ...(initialModel ? { model: initialModel } : {}),
    ...(defaults ? { effort: defaults.effort, runtimeMode: defaults.runtimeMode } : {}),
    ...settings,
  };

  const open = () => void navigate({ to: "/t/$threadId", params: { threadId } });
  const { sending, send: sendDraft } = useSendDraft(
    threadId,
    attachments,
    (message) => {
      // The thread exists by now; the draft waits for a retry in its composer.
      if (message !== null) {
        toast.error(`The message was not sent: ${message}`);
        open();
      }
    },
    () => {
      setText("");
      setMentions([]);
      open();
    },
  );

  const busy = pending || sending;
  const canSend = text.trim().length > 0 || attachments.files.length > 0;

  // `pending` is state, so a second Enter before the re-render would create
  // the same thread twice; the ref closes that window.
  const startingRef = React.useRef(false);
  const send = async () => {
    if (project === undefined || !canSend || busy || startingRef.current) {
      return;
    }
    startingRef.current = true;
    try {
      if (await create(project.projectId, { threadId, navigate: false, settings: shownSettings })) {
        sendDraft({ text: text.trim(), mentions: [], queued: false });
      }
    } finally {
      startingRef.current = false;
    }
  };

  return (
    <div className="flex w-full min-w-0 max-w-[760px] flex-col gap-2">
      <ComposerSurface
        dragging={attachments.dragging}
        context={
          project ? (
            <ProjectPicker projects={projects} value={project.projectId} onPick={onPickProject} />
          ) : undefined
        }
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        {...attachments.dropHandlers}
        aria-label="New thread"
      >
        <ComposerChips
          mentions={[]}
          files={attachments.files}
          onRemoveMention={() => {}}
          onRemoveFile={attachments.removeAt}
        />
        <textarea
          aria-label="Message"
          data-context="composer"
          rows={2}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={attachments.onPaste}
          className={composerInputClassName}
        />
        <ComposerToolbar
          running={false}
          canSend={canSend && project !== undefined}
          interrupting={false}
          sending={busy}
          filesKey={attachments.files.length}
          onFilesPicked={attachments.add}
          onSend={() => void send()}
          onInterrupt={() => {}}
          attachDisabledReason={attachRefusal ?? undefined}
          settings={
            defaults ? (
              <ThreadSettingsControls
                settings={shownSettings}
                models={models}
                runtimeModes={runtimeModeOptions(capabilities)}
                onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
              />
            ) : undefined
          }
        />
        {attachments.rejected === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {attachments.rejected}
          </p>
        )}
      </ComposerSurface>
    </div>
  );
}

export function StartThread() {
  const projects = useProjects();
  const connection = useConnectionState();
  const connected = connection.status === "connected";
  const empty = connected && projects.length === 0;

  // A pick is remembered straight away, not only once a thread is created:
  // the picker should open where the user left it.
  const [lastProject, rememberProject] = useLastProject();
  // A remembered project that has since been removed falls back to the first.
  const project = projects.find((entry) => entry.projectId === lastProject) ?? projects[0];

  if (!connected || empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
        <div className="flex w-full max-w-[760px] flex-col items-center gap-5 text-center">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-base font-medium text-foreground">
              {empty ? "No projects yet" : "Start a thread"}
            </h1>
            <p className="type-body text-muted-foreground">
              {!connected
                ? "No server is connected, so there is nothing to start a thread on yet."
                : "A thread belongs to a project — a directory on this machine the agent works in. Add one to start."}
            </p>
          </div>
          {empty ? <AddProjectDialog trigger="button" /> : null}
        </div>
      </div>
    );
  }

  // Laid out like an open thread with no messages: the greeting in the
  // middle, the composer pinned to the bottom.
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadGreeting project={project} />
      <div className="flex w-full shrink-0 justify-center px-4 pb-4">
        <StartComposer projects={projects} project={project} onPickProject={rememberProject} />
      </div>
    </section>
  );
}
