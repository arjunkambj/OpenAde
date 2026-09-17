/**
 * Finding the plan a plan-mode turn wrote.
 *
 * The interesting case is the headless one. `fixtures/cmd/plan/` is a real
 * `--permission-mode plan` run: the model wrote `subtract-function.md` into
 * `~/.commandcode/plans/` with an ordinary `write_file`, and `plans-index.json`
 * was never touched — so an index-only lookup finds nothing for every plan turn
 * this connector runs.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { plansDirFor, plansIndexPathFor, readPlanProposal } from "./plans";

/** A throwaway `~/.commandcode/plans` with the given files and mtimes. */
const plansHome = (files: Readonly<Record<string, { text: string; at: number }>>): string => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-plans-test-"));
  NodeFS.mkdirSync(plansDirFor(home), { recursive: true });
  for (const [name, file] of Object.entries(files)) {
    const path = NodePath.join(plansDirFor(home), name);
    NodeFS.writeFileSync(path, file.text, "utf8");
    NodeFS.utimesSync(path, file.at / 1000, file.at / 1000);
  }
  return home;
};

const HOUR = 60 * 60 * 1000;

describe("readPlanProposal", () => {
  it("prefers the index entry recorded against the session", () => {
    const now = Date.now();
    const home = plansHome({
      "mine.md": { text: "# mine\n", at: now },
      "theirs.md": { text: "# theirs\n", at: now },
    });
    try {
      NodeFS.writeFileSync(
        plansIndexPathFor(home),
        JSON.stringify({
          version: 1,
          plans: {
            "mine.md": { sessionId: "sess-1", updatedAt: new Date(now).toISOString() },
            "theirs.md": { sessionId: "sess-2", updatedAt: new Date(now).toISOString() },
          },
        }),
        "utf8",
      );
      const proposal = readPlanProposal("sess-1", home, now - HOUR);
      expect(proposal?.planPath.endsWith("mine.md")).toBe(true);
      expect(proposal?.markdown).toBe("# mine\n");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to the file the turn itself wrote, because print mode writes no index", () => {
    const now = Date.now();
    const home = plansHome({
      // Somebody else's plan, from a month of interactive sessions ago.
      "old.md": { text: "# old\n", at: now - 30 * 24 * HOUR },
      "fresh.md": { text: "# fresh\n", at: now },
    });
    try {
      // No plans-index.json at all — exactly what a headless plan turn leaves.
      const proposal = readPlanProposal("sess-1", home, now - 1000);
      expect(proposal?.planPath.endsWith("fresh.md")).toBe(true);
      expect(proposal?.markdown).toBe("# fresh\n");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never proposes a plan older than the turn that is asking", () => {
    const now = Date.now();
    const home = plansHome({ "old.md": { text: "# old\n", at: now - 30 * 24 * HOUR } });
    try {
      expect(readPlanProposal("sess-1", home, now - 1000)).toBeNull();
      // Without a spawn time there is nothing to compare against, so only the
      // index may answer — and there is none.
      expect(readPlanProposal("sess-1", home)).toBeNull();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves to nothing when the directory is missing or the index is corrupt", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-plans-empty-"));
    try {
      expect(readPlanProposal("sess-1", home, 0)).toBeNull();
      NodeFS.mkdirSync(plansDirFor(home), { recursive: true });
      NodeFS.writeFileSync(plansIndexPathFor(home), "{not json", "utf8");
      expect(readPlanProposal("sess-1", home, Date.now())).toBeNull();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
