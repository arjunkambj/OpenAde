/**
 * The `/dev/composer` fixture page — loaded only in a development build. Everything the composer and the
 * interaction cards render comes through the real atom stack; the only fake
 * is the `Connection` layer (`makeFixtureClient`), whose dispatch decider
 * emits the resolved events a server would — so the approval card really does
 * close on `thread.approval.resolved`, the queue strip really fills from
 * `thread.message.queued`, and the command log shows every dispatch.
 *
 * Scenario buttons emit the events a connector/session would produce mid-turn.
 * Keyboard path: Enter sends, Cmd+Enter queues, 1/2/3 answer cards, 3 opens
 * the plan revision field, Escape interrupts a running turn. Every chord is
 * resolved by the one dispatcher in `@/lib/shortcuts` against the fixture's
 * own keybinding table — the editor at the bottom of the page rebinds them
 * live.
 */

import { useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { makeItemId, makeRequestId } from "@OpenAde/contracts/ids";
import type { CommandReceipt } from "@OpenAde/contracts/orchestration";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { Composer } from "@/components/composer/composer";
import { HeaderControls } from "@/components/header-controls";
import { KeybindingsEditor } from "@/components/keybindings/keybindings-editor";
import { ClientRuntimeProvider, useClientRuntime } from "@/lib/client-runtime";
import { makeFixtureClient, type FixtureClient } from "@/lib/fixture-client";
import { KeybindingsProvider, useKeybindingCommand, useKeybindingFlag } from "@/lib/shortcuts";

interface LogEntry {
  readonly id: number;
  readonly label: string;
  readonly status: CommandReceipt["status"] | "fired";
  readonly reason?: string;
}

export function ComposerFixture() {
  const [fixture] = React.useState(() => makeFixtureClient());
  return (
    <ClientRuntimeProvider layer={fixture.layer}>
      {/* Nested on purpose: this one resolves against the fixture's own
          keybinding table, so the editor at the bottom of the page changes
          what the chords do. */}
      <KeybindingsProvider>
        <DevComposerInner fixture={fixture} />
      </KeybindingsProvider>
    </ClientRuntimeProvider>
  );
}

function ScenarioButton({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Button type="button" size="sm" variant="secondary" onClick={onPress}>
      {label}
    </Button>
  );
}

function DevComposerInner({ fixture }: { readonly fixture: FixtureClient }) {
  const { threadDetailAtom } = useClientRuntime();
  const docResult = useAtomValue(threadDetailAtom(fixture.threadId));
  const doc = AsyncResult.isSuccess(docResult) ? docResult.value : null;
  const [log, setLog] = React.useState<ReadonlyArray<LogEntry>>([]);
  const nextLogId = React.useRef(0);

  const pushLog = React.useCallback((entry: Omit<LogEntry, "id">) => {
    setLog((current) => [...current.slice(-19), { ...entry, id: nextLogId.current++ }]);
  }, []);

  React.useEffect(() => {
    fixture.onCommand = (command, receipt) =>
      pushLog({ label: command.type, status: receipt.status, reason: receipt.reason });
    return () => {
      fixture.onCommand = undefined;
    };
  }, [fixture, pushLog]);

  const running = doc !== null && doc.currentTurnId !== null;

  useKeybindingFlag("threadRunning", running);
  useKeybindingCommand("commandPalette.toggle", () =>
    pushLog({ label: "commandPalette.toggle", status: "fired" }),
  );
  useKeybindingCommand("thread.new", () => pushLog({ label: "thread.new", status: "fired" }));
  useKeybindingCommand("browserPane.toggle", () =>
    pushLog({ label: "browserPane.toggle", status: "fired" }),
  );

  const openApproval = (kind: "command" | "file_write" | "mcp_tool") => {
    fixture.startTurn();
    const request =
      kind === "command"
        ? {
            requestId: makeRequestId(),
            kind: "command" as const,
            toolName: "shell_command",
            input: { command: "npm run build" },
            patternSuggestion: "Shell(npm run *)",
            description: "Run a shell command",
          }
        : kind === "file_write"
          ? {
              requestId: makeRequestId(),
              kind: "file_write" as const,
              toolName: "write_file",
              input: { path: "src/components/composer.tsx" },
              patternSuggestion: "Edit(src/**)",
              description: "Write to a file in the project",
            }
          : {
              requestId: makeRequestId(),
              kind: "mcp_tool" as const,
              toolName: "mcp__github__create_issue",
              input: { title: "Composer edge cases" },
              patternSuggestion: "Mcp(github.*)",
              mcpTool: { server: "github", tool: "create_issue" },
              description: "Call the GitHub MCP server",
            };
    fixture.emit("thread.approval.opened", { request });
  };

  const openQuestion = () => {
    fixture.startTurn();
    fixture.emit("thread.userInput.requested", {
      requestId: makeRequestId(),
      questions: [
        {
          questionId: "q-scope",
          header: "Scope",
          question: "Which surface should this change touch?",
          options: [
            { optionId: "scope-composer", label: "Composer only" },
            { optionId: "scope-all", label: "Composer, toolbar and cards" },
          ],
          freeform: true,
        },
        {
          questionId: "q-checks",
          header: "Verification",
          question: "Which checks should run before commit?",
          multiSelect: true,
          options: [
            { optionId: "chk-lint", label: "Lint", description: "oxlint over the workspace" },
            { optionId: "chk-types", label: "Typecheck" },
            { optionId: "chk-tests", label: "Unit tests" },
          ],
        },
      ],
    });
  };

  const openPlan = () => {
    const turnId = fixture.startTurn();
    fixture.emit("thread.plan.proposed", {
      turnId,
      planMarkdown:
        "## Proposed plan\n\n1. Wire the composer through `dispatchAtom`\n2. Add the approval, question and plan cards\n3. Preview permission patterns with the shared matcher\n\n- Accept runs the plan as written\n- Accept and run switches to auto-accept",
      planPath: ".openade/plans/fixture.md",
    });
  };

  const queueTwo = () => {
    fixture.emit("thread.message.queued", {
      message: {
        queuedMessageId: makeItemId(),
        text: "First queued follow-up",
        attachments: [],
        mentions: ["src/app.tsx"],
        queuedAt: new Date().toISOString(),
      },
    });
    fixture.emit("thread.message.queued", {
      message: {
        queuedMessageId: makeItemId(),
        text: "Second queued follow-up, with an attachment",
        attachments: [{ path: "screenshot.png", mime: "image/png" }],
        mentions: [],
        queuedAt: new Date().toISOString(),
      },
    });
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Composer fixture</h1>
        <p className="text-sm text-muted-foreground">
          Every card and trigger, backed by a scripted decider — dispatches round-trip through the
          atom runtime and land in the log below.
        </p>
      </header>

      <section className="flex flex-col gap-2" aria-label="Scenarios">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Scenarios
        </h2>
        <div className="flex flex-wrap gap-2">
          <ScenarioButton label="Approval · shell" onPress={() => openApproval("command")} />
          <ScenarioButton
            label="Approval · file write"
            onPress={() => openApproval("file_write")}
          />
          <ScenarioButton label="Approval · MCP" onPress={() => openApproval("mcp_tool")} />
          <ScenarioButton label="Question card" onPress={openQuestion} />
          <ScenarioButton label="Plan card" onPress={openPlan} />
          <ScenarioButton label="Start turn" onPress={() => fixture.startTurn()} />
          <ScenarioButton label="Complete turn" onPress={() => fixture.completeTurn()} />
          <ScenarioButton label="Queue ×2" onPress={queueTwo} />
          <ScenarioButton label="Reset" onPress={() => fixture.reset()} />
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label="Header controls">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Header controls
        </h2>
        <HeaderControls threadId={fixture.threadId} />
      </section>

      <section className="flex flex-col gap-2" aria-label="Composer">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Composer {running ? "· turn running" : ""}
        </h2>
        <Composer threadId={fixture.threadId} projectId={fixture.projectId} />
      </section>

      <section className="flex flex-col gap-2" aria-label="Dispatch log">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Dispatch log
        </h2>
        <ol className="flex min-h-8 flex-col gap-0.5 font-mono text-xs">
          {log.length === 0 ? (
            <li className="text-muted-foreground">nothing dispatched yet</li>
          ) : (
            log.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2">
                <span>{entry.label}</span>
                <span
                  className={
                    entry.status === "rejected" ? "text-destructive" : "text-muted-foreground"
                  }
                >
                  {entry.status}
                </span>
                {entry.reason === undefined ? null : (
                  <span className="text-muted-foreground">{entry.reason}</span>
                )}
              </li>
            ))
          )}
        </ol>
      </section>

      <KeybindingsEditor />
    </div>
  );
}
