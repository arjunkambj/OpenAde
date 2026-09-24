import type { TerminalId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { runHandOver, type HandOverSteps } from "./terminal-hand-over";

const id = (n: number) => `0199c0de-0012-7000-8000-00000000000${n}` as TerminalId;

/**
 * Steps over a small model of the client: whether the project's and the
 * thread's drawers are open, and a log of every step in order. `whileAdopting`
 * runs in the middle of adopt, after the server has moved the shells and
 * before its reply — where a refetch or a reconnect can land.
 */
const model = (options: {
  readonly open: boolean;
  readonly ids: ReadonlyArray<TerminalId>;
  readonly adopted: ReadonlyArray<TerminalId> | null;
  readonly threadListing: ReadonlyArray<TerminalId> | null;
  readonly whileAdopting?: (state: { projectOpen: boolean }) => void;
}) => {
  const log: Array<string> = [];
  const state = { projectOpen: options.open, threadOpen: false, tabsMoved: false };
  const steps: HandOverSteps = {
    before: () => ({ open: options.open, ids: options.ids }),
    closeProjectDrawer: () => {
      log.push("close project");
      state.projectOpen = false;
    },
    adopt: async () => {
      log.push("adopt");
      options.whileAdopting?.(state);
      return options.adopted;
    },
    listThread: async () => {
      log.push("list thread");
      return options.threadListing;
    },
    moveState: (open) => {
      log.push(`move state${open ? ", open" : ""}`);
      state.tabsMoved = true;
      state.threadOpen = open;
    },
    reopenProjectDrawer: () => {
      log.push("reopen project");
      state.projectOpen = true;
    },
  };
  return { steps, log, state };
};

describe("runHandOver", () => {
  it("closes the project's drawer before adopting, then moves what adopt moved", async () => {
    const { steps, log, state } = model({
      open: true,
      ids: [id(1), id(2)],
      adopted: [id(1), id(2)],
      threadListing: null,
    });
    expect(await runHandOver(steps)).toBe("moved");
    expect(log).toEqual(["close project", "adopt", "move state, open"]);
    expect(state).toEqual({ projectOpen: false, threadOpen: true, tabsMoved: true });
  });

  // (B) A refetch of the project's listing answered after the move but before
  // adopt's reply comes back empty. The drawer is already closed by then, so
  // it has no open, empty drawer in which to start a shell.
  it("has the project's drawer closed while the move is in flight", async () => {
    let openWhenListingLanded: boolean | null = null;
    const { steps } = model({
      open: true,
      ids: [id(1)],
      adopted: [id(1)],
      threadListing: null,
      whileAdopting: (state) => {
        openWhenListingLanded = state.projectOpen;
      },
    });
    await runHandOver(steps);
    expect(openWhenListingLanded).toBe(false);
  });

  // (A) The socket drops after the server moved the shells but before adopt's
  // reply. The thread's listing shows the move happened, so the client state
  // follows as if adopt had answered, and the project's drawer stays closed.
  it("moves the state when adopt's reply is lost but the thread holds the shells", async () => {
    const { steps, log, state } = model({
      open: true,
      ids: [id(1), id(2)],
      adopted: null,
      threadListing: [id(1), id(2)],
    });
    expect(await runHandOver(steps)).toBe("moved");
    expect(log).toEqual(["close project", "adopt", "list thread", "move state, open"]);
    expect(state.projectOpen).toBe(false);
  });

  it("takes any shell in the thread's listing when the client knew of none", async () => {
    const { steps } = model({ open: false, ids: [], adopted: null, threadListing: [id(3)] });
    expect(await runHandOver(steps)).toBe("moved");
  });

  it("reopens the project's drawer when the shells stayed the project's", async () => {
    const { steps, log, state } = model({
      open: true,
      ids: [id(1)],
      adopted: null,
      threadListing: [],
    });
    expect(await runHandOver(steps)).toBe("kept");
    expect(log).toEqual(["close project", "adopt", "list thread", "reopen project"]);
    expect(state).toEqual({ projectOpen: true, threadOpen: false, tabsMoved: false });
  });

  it("leaves the drawer closed when the project had nothing to show", async () => {
    const { steps, log, state } = model({ open: true, ids: [], adopted: [], threadListing: null });
    expect(await runHandOver(steps)).toBe("kept");
    expect(log).toEqual(["close project", "adopt"]);
    expect(state.projectOpen).toBe(false);
  });

  it("changes nothing more when neither adopt nor the thread's listing answers", async () => {
    const { steps, log, state } = model({
      open: true,
      ids: [id(1)],
      adopted: null,
      threadListing: null,
    });
    expect(await runHandOver(steps)).toBe("unknown");
    expect(log).toEqual(["close project", "adopt", "list thread"]);
    expect(state).toEqual({ projectOpen: false, threadOpen: false, tabsMoved: false });
  });

  it("does not touch a drawer that was closed", async () => {
    const { steps, log } = model({
      open: false,
      ids: [id(1)],
      adopted: [id(1)],
      threadListing: null,
    });
    expect(await runHandOver(steps)).toBe("moved");
    expect(log).toEqual(["adopt", "move state"]);
  });
});
