/**
 * The decider: `command + stream state → events`, and nothing else.
 *
 * Pure — no clock, no I/O, no id minting of its own. The engine hands it the
 * folded aggregate state, the cross-aggregate facts it may check (`ctx`), and
 * the means to stamp events (`env`). Tests drive it with fixed ids and a fixed
 * clock, which is why a scripted conversation replays byte-identically.
 *
 * A rejection is a result, not an exception: the command receipts as
 * `rejected` and nothing is appended.
 */

import { DEFAULT_RUNTIME_MODE } from "@OpenAde/contracts/enums";
import type { EventId, ItemId, ProjectId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type {
  Actor,
  Command,
  OrchestrationEvent,
  StreamKind,
} from "@OpenAde/contracts/orchestration";
import type { PermissionScope } from "@OpenAde/contracts/settings";
import type { PlannedEvent } from "../persistence/EventStore";
import type { ProjectDoc, ThreadDoc } from "./state";

/** What one accepted command may write besides its events. */
export interface NewPermissionRule {
  readonly scope: PermissionScope;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly pattern: string;
  readonly decision: "allow" | "deny";
}

export type DecideResult =
  | {
      readonly accepted: true;
      readonly events: ReadonlyArray<PlannedEvent>;
      readonly permissionRule?: NewPermissionRule;
    }
  | { readonly accepted: false; readonly reason: string };

/** The stream a command's events belong to. */
export const streamOf = (
  command: Command,
): {
  readonly streamKind: StreamKind;
  readonly streamId: string;
} =>
  command.type === "project.create" || command.type === "project.remove"
    ? { streamKind: "project", streamId: command.projectId }
    : { streamKind: "thread", streamId: command.threadId };

/**
 * The non-stream facts a decider may check, gathered by the engine inside the
 * command's transaction.
 */
export interface DeciderContext {
  readonly projectExists: (projectId: ProjectId) => boolean;
  readonly workspaceRootTaken: (root: string, exceptProjectId?: ProjectId) => boolean;
  /** Settings default for a thread whose create command did not choose one. */
  readonly defaultModel: string | null;
}

/** Id and clock minting, injected so tests can fix both. */
export interface DecideEnv {
  readonly now: string;
  readonly nextEventId: () => EventId;
  readonly nextTurnId: () => TurnId;
  readonly nextItemId: () => ItemId;
}

const rejected = (reason: string): DecideResult => ({ accepted: false, reason });
const accepted = (
  events: ReadonlyArray<PlannedEvent>,
  permissionRule?: NewPermissionRule,
): DecideResult => ({
  accepted: true,
  events,
  ...(permissionRule === undefined ? {} : { permissionRule }),
});

const event =
  (env: DecideEnv, command: Command, streamKind: StreamKind, streamId: string) =>
  <Type extends OrchestrationEvent["type"]>(
    type: Type,
    payload: Extract<OrchestrationEvent, { type: Type }>["payload"],
    actor: Actor = "user",
  ): PlannedEvent =>
    ({
      eventId: env.nextEventId(),
      streamKind,
      streamId,
      occurredAt: env.now,
      commandId: command.commandId,
      correlationId: command.commandId,
      actor,
      type,
      payload,
    }) as PlannedEvent;

export const decide = (
  command: Command,
  state: { readonly project: ProjectDoc | null; readonly thread: ThreadDoc | null },
  ctx: DeciderContext,
  env: DecideEnv,
): DecideResult => {
  const { streamKind, streamId } = streamOf(command);
  const emit = event(env, command, streamKind, streamId);
  const project = state.project;
  const thread = state.thread;

  switch (command.type) {
    case "project.create": {
      if (project !== null && !project.removed) {
        return rejected(`project ${command.projectId} already exists`);
      }
      if (ctx.workspaceRootTaken(command.workspaceRoot, command.projectId)) {
        return rejected(`workspace root ${command.workspaceRoot} is already a project`);
      }
      return accepted([
        emit("project.created", {
          projectId: command.projectId,
          name: command.name,
          workspaceRoot: command.workspaceRoot,
        }),
      ]);
    }

    case "project.remove": {
      if (project === null || project.removed) {
        return rejected(`project ${command.projectId} does not exist`);
      }
      return accepted([emit("project.removed", { projectId: command.projectId })]);
    }

    case "thread.create": {
      if (!ctx.projectExists(command.projectId)) {
        return rejected(`project ${command.projectId} does not exist`);
      }
      if (thread !== null && !thread.deleted) {
        return rejected(`thread ${command.threadId} already exists`);
      }
      const patch = command.settings ?? {};
      const model = patch.model ?? ctx.defaultModel;
      if (model === null) {
        return rejected("no model configured: pass settings.model or set a default");
      }
      return accepted([
        emit("thread.created", {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title ?? "New thread",
          settings: {
            model,
            runtimeMode: patch.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: patch.interactionMode ?? "default",
            ...(patch.effort === undefined ? {} : { effort: patch.effort }),
          },
        }),
      ]);
    }

    case "thread.rename": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      return accepted([emit("thread.renamed", { title: command.title })]);
    }

    case "thread.archive": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.status === "archived") {
        return rejected(`thread ${command.threadId} is already archived`);
      }
      return accepted([emit("thread.archived", {})]);
    }

    case "thread.delete": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      return accepted([emit("thread.deleted", {})]);
    }

    case "thread.turn.start": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.status === "archived") {
        return rejected(`thread ${command.threadId} is archived`);
      }
      if (thread.currentTurn !== null) {
        if (!command.queued) {
          return rejected("a turn is already running; send with queued: true to queue it");
        }
        return accepted([
          emit("thread.message.queued", {
            message: {
              queuedMessageId: env.nextItemId(),
              text: command.text,
              attachments: command.attachments,
              mentions: command.mentions,
              queuedAt: env.now,
            },
          }),
        ]);
      }
      return accepted([
        emit("thread.turn.requested", {
          turnId: env.nextTurnId(),
          text: command.text,
          attachments: command.attachments,
          mentions: command.mentions,
        }),
      ]);
    }

    case "thread.turn.interrupt": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.currentTurn === null) {
        return rejected(`thread ${command.threadId} has no running turn`);
      }
      return accepted([emit("thread.turn.interrupted", { turnId: thread.currentTurn.turnId })]);
    }

    case "thread.settings.update": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      return accepted([
        emit("thread.settings.updated", {
          ...(command.model === undefined ? {} : { model: command.model }),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
          ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
          ...(command.interactionMode === undefined
            ? {}
            : { interactionMode: command.interactionMode }),
        }),
      ]);
    }

    case "thread.approval.respond": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const request = thread.approvals.find((pending) => pending.requestId === command.requestId);
      if (request === undefined) {
        return rejected(`no pending approval ${command.requestId}`);
      }
      const rule: NewPermissionRule | undefined =
        command.pattern === undefined
          ? undefined
          : command.decision === "allow-always"
            ? {
                scope: "project",
                projectId: thread.projectId,
                pattern: command.pattern,
                decision: "allow",
              }
            : command.decision === "allow-session"
              ? {
                  scope: "session",
                  threadId: command.threadId,
                  pattern: command.pattern,
                  decision: "allow",
                }
              : undefined;
      return accepted(
        [
          emit("thread.approval.resolved", {
            requestId: command.requestId,
            decision: command.decision,
            ...(command.pattern === undefined ? {} : { pattern: command.pattern }),
          }),
        ],
        rule,
      );
    }

    case "thread.userInput.respond": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      const pending = thread.userInputs.find((input) => input.requestId === command.requestId);
      if (pending === undefined) {
        return rejected(`no pending user input ${command.requestId}`);
      }
      return accepted([
        emit("thread.userInput.resolved", {
          requestId: command.requestId,
          answers: command.answers,
        }),
      ]);
    }

    case "thread.plan.respond": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      if (thread.pendingPlan === null || thread.pendingPlan.turnId !== command.turnId) {
        return rejected(`no pending plan for turn ${command.turnId}`);
      }
      return accepted([
        emit("thread.plan.responded", {
          turnId: command.turnId,
          action: command.action,
          ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
        }),
      ]);
    }

    case "thread.checkpoint.restore": {
      if (thread === null || thread.deleted) {
        return rejected(`thread ${command.threadId} does not exist`);
      }
      // Restore is side-effectful git work — `git restore` + `git clean`
      // would clobber files a running turn is mid-write on.
      if (thread.currentTurn !== null) {
        return rejected(`thread ${command.threadId} has a running turn`);
      }
      const checkpoint = thread.checkpoints.find(
        (entry) => entry.checkpointId === command.checkpointId,
      );
      if (checkpoint === undefined) {
        return rejected(`no checkpoint ${command.checkpointId}`);
      }
      // The event is the durable work order: the CheckpointReactor performs
      // the git work on `thread.checkpoint.restored`, so a crash between
      // receipt and restore cannot silently drop the request.
      return accepted([emit("thread.checkpoint.restored", { checkpoint })]);
    }
  }
};
