import { makeCheckpointId, makeThreadId, makeTurnId } from "@OpenAde/contracts/ids";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RestoreCheckpointButton,
  RestoreCheckpointDialog,
} from "@/components/panes/changes/restore-dialog";
import { ClientRuntimeProvider } from "@/lib/client-runtime";
import { makeFixtureClient } from "@/lib/fixture-client";

// The dialog's popup is portalled, which a static render leaves out; render
// its parts in place so the body can be read.
vi.mock("@OpenAde/ui/components/dialog", () => {
  const part = ({ children }: { readonly children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({
      open,
      children,
    }: {
      readonly open: boolean;
      readonly children?: React.ReactNode;
    }) => (open ? <div data-dialog>{children}</div> : null),
    DialogContent: part,
    DialogDescription: part,
    DialogFooter: part,
    DialogHeader: part,
    DialogTitle: part,
  };
});

const turnId = makeTurnId();
const checkpoint = {
  checkpointId: makeCheckpointId(),
  turnId,
  ref: `refs/openade/checkpoints/t/${turnId}`,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ClientRuntimeProvider layer={makeFixtureClient().layer}>{node}</ClientRuntimeProvider>,
  );

describe("RestoreCheckpointDialog", () => {
  const props = {
    open: true,
    onOpenChange: () => {},
    threadId: makeThreadId(),
    checkpoint,
    title: "Restore to before this message?",
    description: "The workspace goes back to how it was before this message was sent.",
  };

  it("shows the caller's wording, the note, and that the restore is queued", () => {
    const markup = render(
      <RestoreCheckpointDialog {...props} note="This undoes a turn too." blockedReason={null} />,
    );
    expect(markup).toContain("Restore to before this message?");
    expect(markup).toContain("before this message was sent.");
    expect(markup).toContain("This undoes a turn too.");
    expect(markup).toContain("The restore is queued on the thread");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Restore<\/button>/);
  });

  it("keeps Restore disabled and says why while a restore cannot start", () => {
    const markup = render(
      <RestoreCheckpointDialog {...props} blockedReason="A turn is running." />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("A turn is running.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Restore<\/button>/);
  });

  it("renders nothing while closed", () => {
    expect(render(<RestoreCheckpointDialog {...props} open={false} blockedReason={null} />)).toBe(
      "",
    );
  });
});

describe("RestoreCheckpointButton", () => {
  const props = {
    threadId: makeThreadId(),
    label: "turn 2",
    onAccepted: () => {},
  };

  it("opens nothing until pressed and names what it restores", () => {
    const markup = render(
      <RestoreCheckpointButton {...props} checkpoint={checkpoint} disabledReason={null} />,
    );
    expect(markup).toContain('title="Restore the worktree to turn 2"');
    expect(markup).not.toContain("data-dialog");
    expect(markup).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("is disabled with the reason, or without a checkpoint", () => {
    expect(
      render(<RestoreCheckpointButton {...props} checkpoint={checkpoint} disabledReason="Busy." />),
    ).toMatch(/<button[^>]*disabled=""[^>]*title="Busy\."/);
    expect(
      render(<RestoreCheckpointButton {...props} checkpoint={null} disabledReason={null} />),
    ).toMatch(/<button[^>]*disabled=""/);
  });
});
