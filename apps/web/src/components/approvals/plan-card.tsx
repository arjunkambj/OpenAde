/**
 * The proposed-plan card. `accept` and `accept-auto` dispatch
 * `thread.plan.respond` directly; `revise` opens the feedback field and sends
 * it with the response. The card closes when `thread.plan.responded` clears
 * `doc.pendingPlan` — nothing here closes it optimistically.
 *
 * Keys: `1` accept, `2` accept and run, `3` focus the feedback field,
 * `Escape` is left to the composer (a plan is not a prompt that blocks on an
 * answer, so the card does not deny).
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Kbd } from "@OpenAde/ui/components/kbd";
import { Textarea } from "@OpenAde/ui/components/textarea";
import type { ThreadId, TurnId } from "@OpenAde/contracts/ids";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { PlanResponseAction } from "@OpenAde/contracts/orchestration";
import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CardShell } from "@/components/approvals/card-shell";
import { useClientRuntime } from "@/lib/client-runtime";

/** The elements a plan actually uses, styled against theme tokens. */
const markdownComponents = {
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="mt-2 mb-1 text-base font-semibold" {...props} />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="mt-2 mb-1 text-sm font-semibold" {...props} />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mt-2 mb-1 text-sm font-medium" {...props} />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="my-1 leading-prose" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="my-1 list-disc pl-5" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="my-1 list-decimal pl-5" {...props} />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="my-0.5" {...props} />,
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code className="rounded-sm bg-muted px-1 font-mono text-xs" {...props} />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre className="my-1 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs" {...props} />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary underline" {...props} />
  ),
};

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable);

export function PlanCard({
  threadId,
  plan,
}: {
  readonly threadId: ThreadId;
  readonly plan: {
    readonly turnId: TurnId;
    readonly planMarkdown: string;
    readonly planPath?: string;
  };
}) {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [revising, setRevising] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PlanResponseAction | null>(null);
  const feedbackRef = React.useRef<HTMLTextAreaElement>(null);

  const respond = React.useCallback(
    (action: PlanResponseAction, note?: string) => {
      setPending(action);
      setError(null);
      void dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.plan.respond",
        threadId,
        turnId: plan.turnId,
        action,
        ...(note === undefined || note.length === 0 ? {} : { feedback: note }),
      }).then((receipt) => {
        setPending(null);
        if (receipt.status === "rejected") {
          setError(receipt.reason ?? "the server rejected the response");
        }
      });
    },
    [dispatch, plan.turnId, threadId],
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isEditableTarget(event.target)) {
        if (event.key === "Escape") {
          (event.target as HTMLElement).blur();
          event.stopPropagation();
        }
        return;
      }
      if (event.key === "1") {
        event.preventDefault();
        respond("accept");
      } else if (event.key === "2") {
        event.preventDefault();
        respond("accept-auto");
      } else if (event.key === "3") {
        event.preventDefault();
        setRevising(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [respond]);

  React.useEffect(() => {
    if (revising) {
      feedbackRef.current?.focus();
    }
  }, [revising]);

  return (
    <CardShell
      icon="hugeicons:check-list"
      title="Proposed plan"
      hint={
        plan.planPath === undefined ? null : (
          <span className="max-w-48 truncate font-mono">{plan.planPath}</span>
        )
      }
      actions={
        <>
          <Button size="sm" disabled={pending !== null} onClick={() => respond("accept")}>
            Accept <Kbd>1</Kbd>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null}
            onClick={() => respond("accept-auto")}
          >
            Accept and run <Kbd>2</Kbd>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="muted"
            disabled={pending !== null}
            onClick={() => setRevising((open) => !open)}
            aria-expanded={revising}
          >
            Revise <Kbd>3</Kbd>
          </Button>
        </>
      }
    >
      <div className="max-h-56 max-w-none overflow-auto text-sm text-foreground">
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {plan.planMarkdown}
        </Markdown>
      </div>
      {revising ? (
        <div className="flex min-w-0 flex-col gap-2">
          <Textarea
            ref={feedbackRef}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="What should change?"
            aria-label="Plan feedback"
            rows={3}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                respond("revise", feedback.trim());
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending !== null || feedback.trim().length === 0}
              onClick={() => respond("revise", feedback.trim())}
            >
              Send revision
            </Button>
            <span className="text-xs text-muted-foreground">
              <Kbd>⌘</Kbd>+<Kbd>Enter</Kbd> sends
            </span>
          </div>
        </div>
      ) : null}
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </CardShell>
  );
}
