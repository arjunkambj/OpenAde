import { describe, expect, it } from "vitest";

import {
  makeCommandId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { Command } from "@OpenAde/contracts/orchestration";

import { decide, type DeciderContext, type DecideEnv } from "./decider";
import type { ProjectDoc, ThreadDoc } from "./state";

const NOW = "2026-01-02T03:04:05.000Z";

const env: DecideEnv = {
  now: NOW,
  nextEventId: makeEventId,
  nextTurnId: makeTurnId,
  nextItemId: makeItemId,
};

const ctx = (overrides: Partial<DeciderContext> = {}): DeciderContext => ({
  projectExists: () => true,
  workspaceRootTaken: () => false,
  restoreInFlight: () => false,
  defaultModel: "fake/model",
  defaultEffort: null,
  defaultRuntimeMode: null,
  ...overrides,
});

const baseCommand = { commandId: makeCommandId(), createdAt: NOW };

const QUEUED_ID = makeItemId();
const SECOND_QUEUED_ID = makeItemId();

const queuedMessage = (queuedMessageId: string, text: string) => ({
  queuedMessageId: queuedMessageId as ReturnType<typeof makeItemId>,
  text,
  attachments: [],
  mentions: [],
  queuedAt: NOW,
});

const threadDoc = (overrides: Partial<ThreadDoc> = {}): ThreadDoc => ({
  threadId: makeThreadId(),
  projectId: makeProjectId(),
  title: "Thread",
  status: "idle",
  settings: {
    model: "fake/model",
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  snapshotSequence: 1,
  items: [],
  queue: [],
  checkpoints: [],
  session: null,
  currentTurn: null,
  interrupting: false,
  restoring: false,
  pendingPlan: null,
  usage: null,
  context: null,
  createdAt: NOW,
  updatedAt: NOW,
  approvals: [],
  userInputs: [],
  preview: undefined,
  deleted: false,
  ...overrides,
});

const projectDoc = (overrides: Partial<ProjectDoc> = {}): ProjectDoc => ({
  projectId: makeProjectId(),
  name: "demo",
  workspaceRoot: "/repo",
  createdAt: NOW,
  updatedAt: NOW,
  removed: false,
  ...overrides,
});

interface Row {
  readonly name: string;
  readonly command: Command;
  readonly thread?: ThreadDoc | null;
  readonly project?: ProjectDoc | null;
  readonly context?: DeciderContext;
  readonly events?: ReadonlyArray<string>;
  readonly rejects?: string;
  readonly rule?: { readonly scope: string; readonly pattern: string };
}

const rows: ReadonlyArray<Row> = [
  {
    name: "project.create emits project.created",
    command: {
      ...baseCommand,
      type: "project.create",
      projectId: makeProjectId(),
      name: "demo",
      workspaceRoot: "/repo",
    } as Command,
    project: null,
    events: ["project.created"],
  },
  {
    name: "project.create rejects an existing project",
    command: {
      ...baseCommand,
      type: "project.create",
      projectId: makeProjectId(),
      name: "demo",
      workspaceRoot: "/repo",
    } as Command,
    project: projectDoc(),
    rejects: "already exists",
  },
  {
    name: "project.create rejects a taken workspace root",
    command: {
      ...baseCommand,
      type: "project.create",
      projectId: makeProjectId(),
      name: "demo",
      workspaceRoot: "/repo",
    } as Command,
    project: null,
    context: ctx({ workspaceRootTaken: () => true }),
    rejects: "already a project",
  },
  {
    name: "project.remove emits project.removed",
    command: {
      ...baseCommand,
      type: "project.remove",
      projectId: makeProjectId(),
    } as Command,
    project: projectDoc(),
    events: ["project.removed"],
  },
  {
    name: "project.remove rejects a missing project",
    command: {
      ...baseCommand,
      type: "project.remove",
      projectId: makeProjectId(),
    } as Command,
    project: null,
    rejects: "does not exist",
  },
  {
    name: "thread.create emits thread.created with resolved settings",
    command: {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as Command,
    thread: null,
    events: ["thread.created"],
  },
  {
    name: "thread.create rejects a missing project",
    command: {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as Command,
    thread: null,
    context: ctx({ projectExists: () => false }),
    rejects: "does not exist",
  },
  {
    name: "thread.create rejects when no model resolves",
    command: {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as Command,
    thread: null,
    context: ctx({ defaultModel: null }),
    rejects: "no model",
  },
  {
    name: "thread.rename emits thread.renamed",
    command: {
      ...baseCommand,
      type: "thread.rename",
      threadId: makeThreadId(),
      title: "New title",
    } as Command,
    thread: threadDoc(),
    events: ["thread.renamed"],
  },
  {
    name: "thread.rename rejects a missing thread",
    command: {
      ...baseCommand,
      type: "thread.rename",
      threadId: makeThreadId(),
      title: "New title",
    } as Command,
    thread: null,
    rejects: "does not exist",
  },
  {
    name: "thread.archive emits thread.archived",
    command: {
      ...baseCommand,
      type: "thread.archive",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    events: ["thread.archived"],
  },
  {
    name: "thread.archive rejects an archived thread",
    command: {
      ...baseCommand,
      type: "thread.archive",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({ status: "archived" }),
    rejects: "already archived",
  },
  {
    name: "thread.delete emits thread.deleted",
    command: {
      ...baseCommand,
      type: "thread.delete",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    events: ["thread.deleted"],
  },
  {
    name: "thread.turn.start emits thread.turn.requested",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc(),
    // The user's own timeline row is minted with the turn: nothing else does.
    events: ["thread.turn.requested", "thread.item.upserted"],
  },
  {
    name: "thread.turn.start rejects during a turn when not queued",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
    }),
    rejects: "already running",
  },
  {
    name: "thread.turn.start queues during a turn",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "queued work",
      attachments: [],
      mentions: [],
      queued: true,
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
    }),
    events: ["thread.message.queued"],
  },
  {
    name: "thread.turn.start queues rather than rejecting while an interrupt settles",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "typed right after stop",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      interrupting: true,
      status: "running",
    }),
    events: ["thread.message.queued"],
  },
  {
    name: "thread.turn.start rejects on an archived thread",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({ status: "archived" }),
    rejects: "archived",
  },
  {
    name: "thread.turn.interrupt emits thread.turn.interrupted",
    command: {
      ...baseCommand,
      type: "thread.turn.interrupt",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
    }),
    events: ["thread.turn.interrupted"],
  },
  {
    name: "thread.turn.interrupt rejects with no running turn",
    command: {
      ...baseCommand,
      type: "thread.turn.interrupt",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc(),
    rejects: "no running turn",
  },
  {
    name: "thread.turn.interrupt rejects a second stop while the first settles",
    command: {
      ...baseCommand,
      type: "thread.turn.interrupt",
      threadId: makeThreadId(),
    } as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      interrupting: true,
      status: "running",
    }),
    rejects: "already stopping",
  },
  {
    name: "thread.settings.update emits thread.settings.updated",
    command: {
      ...baseCommand,
      type: "thread.settings.update",
      threadId: makeThreadId(),
      runtimeMode: "auto-accept-edits",
    } as Command,
    thread: threadDoc(),
    events: ["thread.settings.updated"],
  },
  {
    name: "thread.approval.respond resolves a pending request",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-1" as Command extends infer _ ? never : never,
      decision: "allow-once",
    } as unknown as Command,
    thread: threadDoc({
      approvals: [
        {
          requestId: "req-1" as never,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      ],
      status: "waiting",
    }),
    events: ["thread.approval.resolved"],
  },
  {
    name: "thread.approval.respond rejects an unknown request",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-unknown",
      decision: "allow-once",
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no pending approval",
  },
  {
    name: "thread.approval.respond allow-always records a project rule",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-1",
      decision: "allow-always",
      pattern: "Shell(npm run *)",
    } as unknown as Command,
    thread: threadDoc({
      approvals: [
        {
          requestId: "req-1" as never,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build" },
          description: "Run build",
        },
      ],
      status: "waiting",
    }),
    events: ["thread.approval.resolved"],
    rule: { scope: "project", pattern: "Shell(npm run *)" },
  },
  {
    name: "thread.approval.respond allow-session records a session rule",
    command: {
      ...baseCommand,
      type: "thread.approval.respond",
      threadId: makeThreadId(),
      requestId: "req-1",
      decision: "allow-session",
      pattern: "Shell(ls *)",
    } as unknown as Command,
    thread: threadDoc({
      approvals: [
        {
          requestId: "req-1" as never,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls -la" },
          description: "List files",
        },
      ],
      status: "waiting",
    }),
    events: ["thread.approval.resolved"],
    rule: { scope: "session", pattern: "Shell(ls *)" },
  },
  {
    name: "thread.userInput.respond resolves a pending request",
    command: {
      ...baseCommand,
      type: "thread.userInput.respond",
      threadId: makeThreadId(),
      requestId: "req-in",
      answers: [],
    } as unknown as Command,
    thread: threadDoc({
      userInputs: [{ requestId: "req-in" as never, questions: [] }],
      status: "waiting",
    }),
    events: ["thread.userInput.resolved"],
  },
  {
    name: "thread.userInput.respond rejects an unknown request",
    command: {
      ...baseCommand,
      type: "thread.userInput.respond",
      threadId: makeThreadId(),
      requestId: "req-none",
      answers: [],
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no pending user input",
  },
  {
    name: "thread.plan.respond accepts a pending plan",
    command: {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-1",
      action: "accept",
    } as unknown as Command,
    thread: threadDoc({
      pendingPlan: {
        turnId: "turn-1" as never,
        planMarkdown: "# Plan",
      },
      status: "waiting",
    }),
    events: ["thread.plan.responded"],
  },
  {
    name: "thread.plan.respond rejects a mismatched turn",
    command: {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-2",
      action: "accept",
    } as unknown as Command,
    thread: threadDoc({
      pendingPlan: { turnId: "turn-1" as never, planMarkdown: "# Plan" },
      status: "waiting",
    }),
    rejects: "no pending plan",
  },
  {
    name: "thread.checkpoint.restore emits the durable work order",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({
      checkpoints: [
        {
          checkpointId: "cp-1" as never,
          turnId: makeTurnId(),
          ref: "refs/ade/checkpoint/cp-1",
          createdAt: NOW,
        },
      ],
    }),
    events: ["thread.checkpoint.restore.requested"],
  },
  {
    name: "thread.checkpoint.restore rejects while a turn is running",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({
      currentTurn: {
        turnId: makeTurnId(),
        input: { text: "in-flight", attachments: [], mentions: [] },
      },
      status: "running",
      checkpoints: [
        {
          checkpointId: "cp-1" as never,
          turnId: makeTurnId(),
          ref: "refs/ade/checkpoint/cp-1",
          createdAt: NOW,
        },
      ],
    }),
    rejects: "running turn",
  },
  {
    name: "thread.turn.start rejects while a checkpoint restore is in flight",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc({ restoring: true }),
    rejects: "restoring a checkpoint",
  },
  {
    name: "thread.checkpoint.restore rejects a second restore while one is in flight",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({ restoring: true }),
    rejects: "already restoring",
  },
  {
    // `git restore` + `git clean -fd` run over the project's workspace root,
    // which every thread of the project shares: a sibling's restore would
    // delete whatever this turn wrote.
    name: "thread.turn.start rejects while a sibling thread is restoring",
    command: {
      ...baseCommand,
      type: "thread.turn.start",
      threadId: makeThreadId(),
      text: "hello",
      attachments: [],
      mentions: [],
      queued: false,
    } as Command,
    thread: threadDoc(),
    context: ctx({ restoreInFlight: () => true }),
    rejects: "another thread in project",
  },
  {
    name: "thread.checkpoint.restore rejects while a sibling thread is restoring",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-1",
    } as unknown as Command,
    thread: threadDoc({
      checkpoints: [
        {
          checkpointId: "cp-1" as never,
          turnId: makeTurnId(),
          ref: "refs/ade/checkpoint/cp-1",
          createdAt: NOW,
        },
      ],
    }),
    context: ctx({ restoreInFlight: () => true }),
    rejects: "another thread in project",
  },
  {
    name: "thread.queue.remove emits thread.message.dequeued",
    command: {
      ...baseCommand,
      type: "thread.queue.remove",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
    } as unknown as Command,
    thread: threadDoc({
      queue: [
        {
          queuedMessageId: QUEUED_ID,
          text: "take this back",
          attachments: [],
          mentions: [],
          queuedAt: NOW,
        },
      ],
    }),
    events: ["thread.message.dequeued"],
  },
  {
    name: "thread.queue.remove rejects a message the queue no longer holds",
    command: {
      ...baseCommand,
      type: "thread.queue.remove",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no queued message",
  },
  {
    name: "thread.queue.reorder rejects a position the queue does not have",
    command: {
      ...baseCommand,
      type: "thread.queue.reorder",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
      toIndex: 3,
    } as unknown as Command,
    thread: threadDoc({ queue: [queuedMessage(QUEUED_ID, "only one")] }),
    rejects: "no position 3",
  },
  {
    name: "thread.queue.reorder accepts a move to where the message already is",
    command: {
      ...baseCommand,
      type: "thread.queue.reorder",
      threadId: makeThreadId(),
      queuedMessageId: QUEUED_ID,
      toIndex: 0,
    } as unknown as Command,
    thread: threadDoc({ queue: [queuedMessage(QUEUED_ID, "already first")] }),
    events: [],
  },
  {
    name: "thread.checkpoint.restore rejects an unknown checkpoint",
    command: {
      ...baseCommand,
      type: "thread.checkpoint.restore",
      threadId: makeThreadId(),
      checkpointId: "cp-none",
    } as unknown as Command,
    thread: threadDoc(),
    rejects: "no checkpoint",
  },
];

describe("decide", () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = decide(
        row.command,
        { project: row.project ?? null, thread: row.thread ?? null },
        row.context ?? ctx(),
        env,
      );
      if (row.rejects !== undefined) {
        expect(result.accepted).toBe(false);
        if (!result.accepted) {
          expect(result.reason).toContain(row.rejects);
        }
        return;
      }
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.events.map((event) => event.type)).toEqual(row.events);
        if (row.rule !== undefined) {
          expect(result.permissionRule?.scope).toBe(row.rule.scope);
          expect(result.permissionRule?.pattern).toBe(row.rule.pattern);
        }
      }
    });
  }

  it("copies the pending plan's path onto thread.plan.responded", () => {
    const command = {
      ...baseCommand,
      type: "thread.plan.respond",
      threadId: makeThreadId(),
      turnId: "turn-1",
      action: "accept",
    } as unknown as Command;
    const thread = threadDoc({
      pendingPlan: {
        turnId: "turn-1" as never,
        planMarkdown: "# Plan",
        planPath: "/home/u/.commandcode/plans/the-plan.md",
      },
      status: "waiting",
    });
    const result = decide(command, { project: null, thread }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      // The fold clears pendingPlan on this event, so the path has to ride
      // along on it — a reactor that restarts before the answer has no
      // other source for the file the implement turn names.
      const payload = result.events[0]!.payload as { planPath?: string };
      expect(payload.planPath).toBe("/home/u/.commandcode/plans/the-plan.md");
    }
  });

  it("emits the whole queue order when a message moves", () => {
    const command = {
      ...baseCommand,
      type: "thread.queue.reorder",
      threadId: makeThreadId(),
      queuedMessageId: SECOND_QUEUED_ID,
      toIndex: 0,
    } as unknown as Command;
    const thread = threadDoc({
      queue: [queuedMessage(QUEUED_ID, "first"), queuedMessage(SECOND_QUEUED_ID, "second")],
    });
    const result = decide(command, { project: null, thread }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.events.map((event) => event.type)).toEqual(["thread.queue.reordered"]);
      const payload = result.events[0]!.payload as { order: ReadonlyArray<string> };
      expect(payload.order).toEqual([SECOND_QUEUED_ID, QUEUED_ID]);
    }
  });

  it("emits thread.created with caller settings over defaults", () => {
    const command = {
      commandId: "cmd",
      createdAt: NOW,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      title: "Titled",
      settings: {
        model: "other/model",
        runtimeMode: "full-access",
        interactionMode: "plan",
        effort: "high",
      },
    } as unknown as Command;
    const result = decide(command, { project: null, thread: null }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const payload = result.events[0]!.payload as { settings: unknown };
      expect(payload.settings).toEqual({
        model: "other/model",
        runtimeMode: "full-access",
        interactionMode: "plan",
        effort: "high",
      });
    }
  });

  it("takes effort and runtime mode from the settings defaults", () => {
    // The renderer's only create path sends no settings at all, so "New thread
    // defaults" is the only place these two can come from. They used to be
    // dropped: the panel wrote them, read them back and nothing applied them.
    const command = {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as unknown as Command;
    const result = decide(
      command,
      { project: null, thread: null },
      ctx({ defaultEffort: "high", defaultRuntimeMode: "full-access" }),
      env,
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const payload = result.events[0]!.payload as { settings: unknown };
      expect(payload.settings).toEqual({
        model: "fake/model",
        runtimeMode: "full-access",
        interactionMode: "default",
        effort: "high",
      });
    }
  });

  it("keeps the built-in fallbacks when the defaults hold nothing", () => {
    const command = {
      ...baseCommand,
      type: "thread.create",
      threadId: makeThreadId(),
      projectId: makeProjectId(),
    } as unknown as Command;
    const result = decide(command, { project: null, thread: null }, ctx(), env);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const payload = result.events[0]!.payload as { settings: unknown };
      expect(payload.settings).toEqual({
        model: "fake/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
    }
  });
});

describe("the user's own timeline row", () => {
  const start = (attachments: ReadonlyArray<{ path: string; mime?: string }>) =>
    decide(
      {
        ...baseCommand,
        type: "thread.turn.start",
        threadId: makeThreadId(),
        text: "what is in this picture?",
        attachments,
        mentions: [],
        queued: false,
      } as Command,
      { project: null, thread: threadDoc() },
      ctx(),
      env,
    );

  it("carries the text and the turn it belongs to", () => {
    const result = start([]);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const requested = result.events[0]!.payload as { turnId: string };
    const upserted = result.events[1]!.payload as {
      turnId: string;
      item: { kind: string; text: string; attachments?: unknown };
    };
    expect(upserted.item.kind).toBe("user_message");
    expect(upserted.item.text).toBe("what is in this picture?");
    expect(upserted.turnId).toBe(requested.turnId);
    // No attachments, no field — the row stays as small as the message.
    expect(upserted.item.attachments).toBeUndefined();
  });

  it("carries the attachment references so the row can draw a thumbnail", () => {
    const attachments = [{ path: "/home/.openade/attachments/t/abc-shot.png", mime: "image/png" }];
    const result = start(attachments);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const upserted = result.events[1]!.payload as { item: { attachments?: unknown } };
    expect(upserted.item.attachments).toEqual(attachments);
  });
});
