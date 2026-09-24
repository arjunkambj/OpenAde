/**
 * The `/dev/timeline` fixture page — loaded only in a development build. It
 * renders the real `Timeline` over the real atom stack; the only fake is the
 * `Connection` layer (`makeFixtureClient`), so every read a row makes — an
 * attachment's bytes, the checkpoints, a dispatched restore — goes through
 * the same RPC path the app uses and resolves offline.
 *
 * Two scenarios, loaded into the fixture's document with `fixture.load`:
 *
 *  - "Every kind" decodes `contracts/fixtures/thread-detail-snapshot.json`,
 *    one of every `ItemKind` in one thread.
 *  - "Conversation" is `buildRichTimelineSnapshot`: settled turns with real
 *    work, long and markdown user messages with attachments, code in several
 *    languages, file paths, decisions, a steered message and a running turn.
 *
 * Controls:
 *
 *  - ×1 / ×10 / ×50 replicate the scenario with fresh ids — the ×50 case is
 *    the virtualization check.
 *  - "Live turn" starts a turn (`turn.requested` + `turn.started`, a fresh
 *    turn id so the working clock starts from zero) or settles the running one.
 *  - "Stream" types an assistant message into the running turn a few words at
 *    a time, as coalesced deltas arrive; it starts a turn if none runs.
 *  - "Send" dispatches `thread.turn.start` through the fixture's decider — the
 *    running turn is settled first so the message is not queued — and then
 *    streams the reply, which is the send-anchoring case.
 *  - "Narrow" squeezes the timeline to a phone-width column.
 *
 * The header shows the last command the page dispatched and its receipt — a
 * restore names the turn whose checkpoint it asked for — so "Restore to here"
 * can be checked against the message it sits under.
 *
 * A file chip's request opens the real Files pane beside the timeline, over
 * the fixture's `files.read`, the way the thread view opens its dock on Files.
 * The page publishes `threadOpen` as the thread view does, so the timeline's
 * own keys — jump to latest, collapse all, expand all — work here too.
 *  - The theme toggle exercises both token sets.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import everyKindJson from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import { makeCommandId } from "@OpenAde/contracts/ids";
import {
  type Command,
  type CommandReceipt,
  ThreadDetailSnapshot,
} from "@OpenAde/contracts/orchestration";
import { cn } from "@OpenAde/ui/lib/utils";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { TimelineFixtureControls, type Scenario } from "@/components/dev/timeline-fixture-controls";
import { FilesPane } from "@/components/panes/files/files-pane";
import { useRevealFile } from "@/components/panes/files/files-view";
import { buildRichTimelineSnapshot } from "@/components/dev/timeline-fixture-data";
import { settleStream, streamTick } from "@/components/dev/timeline-fixture-stream";
import { SEND_ASKS } from "@/components/dev/timeline-fixture-text";
import { Timeline } from "@/components/timeline/timeline";
import { ClientRuntimeProvider, useClientRuntime } from "@/lib/client-runtime";
import { makeFixtureClient, type FixtureClient } from "@/lib/fixture-client";
import { cloneDecisions, cloneItems } from "@/lib/fixture-clone";
import { turnOrder } from "@/components/timeline/turn-checkpoints";
import { KeybindingsProvider, useKeybindingFlag } from "@/lib/shortcuts";
import { type FileRevealTarget, useFileRevealRequests } from "@/state/file-reveal";
import { noteLocalSend } from "@/state/local-sends";
import { Close } from "@honeyicons/react";

const everyKind = Schema.decodeUnknownSync(ThreadDetailSnapshot)(everyKindJson);

/** How often a Stream tick lands: slower than real deltas, so each append can be watched. */
const STREAM_TICK_MS = 120;

/** The dispatch log's line: the command, what it asked for, and the receipt. */
const describeDispatch = (
  command: Command,
  receipt: CommandReceipt,
  doc: ThreadDetailSnapshot,
): string => {
  let what: string = command.type;
  if (command.type === "thread.checkpoint.restore") {
    const checkpoint = doc.checkpoints.find((entry) => entry.checkpointId === command.checkpointId);
    const turn = checkpoint === undefined ? -1 : turnOrder(doc.items).indexOf(checkpoint.turnId);
    what = `${command.type} to turn ${turn + 1}'s checkpoint`;
  }
  return `${what} · ${receipt.status}${receipt.reason === undefined ? "" : ` (${receipt.reason})`}`;
};

const scenarioSnapshot = (scenario: Scenario, copies: number): ThreadDetailSnapshot =>
  scenario === "conversation"
    ? buildRichTimelineSnapshot({ copies })
    : {
        ...everyKind,
        items: cloneItems(everyKind.items, copies),
        decisions: cloneDecisions(everyKind.decisions ?? [], copies),
      };

export function TimelineFixture() {
  const [client] = React.useState(() => {
    const made = makeFixtureClient();
    made.load(scenarioSnapshot("conversation", 1));
    return made;
  });
  return (
    <ClientRuntimeProvider layer={client.layer}>
      {/* Nested so the timeline's keys resolve against the fixture's own
          keybinding table, as on `/dev/composer`. */}
      <KeybindingsProvider>
        <TimelineFixturePage client={client} />
      </KeybindingsProvider>
    </ClientRuntimeProvider>
  );
}

function TimelineFixturePage({ client }: { readonly client: FixtureClient }) {
  const { threadDetailAtom, dispatchAtom } = useClientRuntime();
  const result = useAtomValue(threadDetailAtom(client.threadId));
  const snapshot = AsyncResult.isSuccess(result) ? result.value : null;
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  const [scenario, setScenario] = React.useState<Scenario>("conversation");
  const [multiplier, setMultiplier] = React.useState(1);
  const [streaming, setStreaming] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const sends = React.useRef(0);
  const [lastDispatch, setLastDispatch] = React.useState<string | null>(null);
  React.useEffect(() => {
    client.onCommand = (command, receipt) =>
      setLastDispatch(describeDispatch(command, receipt, client.doc()));
    return () => {
      client.onCommand = undefined;
    };
  }, [client]);
  const running = snapshot !== null && snapshot.currentTurnId !== null;
  // The timeline's keys (jump to latest, collapse and expand all) answer while
  // a thread is open; this page stands in for the thread view that says so.
  useKeybindingFlag("threadOpen", true);

  const [filesOpen, setFilesOpen] = React.useState(false);
  const revealFile = useRevealFile(client.threadId);
  const showFile = React.useCallback(
    (target: FileRevealTarget) => {
      revealFile(target);
      setFilesOpen(true);
    },
    [revealFile],
  );
  useFileRevealRequests(client.threadId, showFile);

  React.useEffect(() => {
    if (!streaming) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!streamTick(client)) {
        setStreaming(false);
      }
    }, STREAM_TICK_MS);
    return () => window.clearInterval(timer);
  }, [client, streaming]);

  const stopStreaming = () => {
    setStreaming(false);
    settleStream(client);
  };

  const load = (nextScenario: Scenario, nextMultiplier: number) => {
    setStreaming(false);
    setScenario(nextScenario);
    setMultiplier(nextMultiplier);
    client.load(scenarioSnapshot(nextScenario, nextMultiplier));
  };

  const toggleLive = () => {
    if (running) {
      stopStreaming();
      client.completeTurn();
    } else {
      client.startTurn();
    }
  };

  const send = () => {
    stopStreaming();
    client.completeTurn();
    const text = SEND_ASKS[sends.current % SEND_ASKS.length] ?? SEND_ASKS[0];
    sends.current += 1;
    noteLocalSend(client.threadId);
    void dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.turn.start",
      threadId: client.threadId,
      text,
      attachments: [],
      mentions: [],
      queued: false,
    }).then((receipt) => setStreaming(receipt.status === "accepted"));
  };

  return (
    <div className="flex h-svh flex-col bg-background">
      <TimelineFixtureControls
        scenario={scenario}
        multiplier={multiplier}
        onLoad={load}
        itemCount={snapshot?.items.length ?? 0}
        lastDispatch={lastDispatch}
        running={running}
        onLive={toggleLive}
        streaming={streaming}
        onStream={() => (streaming ? stopStreaming() : setStreaming(true))}
        onSend={send}
        narrow={narrow}
        onNarrow={() => setNarrow((current) => !current)}
      />
      <div className="flex min-h-0 flex-1 justify-center">
        <div
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col",
            narrow && "max-w-sm border-x border-border",
          )}
        >
          {snapshot === null ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading the fixture thread…</p>
          ) : (
            <Timeline key={`${scenario}-${multiplier}`} snapshot={snapshot} />
          )}
        </div>
        {filesOpen && snapshot !== null ? (
          <aside
            aria-label="Files"
            className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border bg-sidebar"
          >
            <div className="flex shrink-0 items-center justify-between py-0.5 pr-1.5 pl-3 type-body font-medium">
              Files
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Close files"
                      onClick={() => setFilesOpen(false)}
                    />
                  }
                >
                  <Close variant="bold" />
                </TooltipTrigger>
                <TooltipContent>Close files</TooltipContent>
              </Tooltip>
            </div>
            <div className="min-h-0 flex-1">
              <FilesPane projectId={snapshot.projectId} threadId={snapshot.threadId} connected />
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
