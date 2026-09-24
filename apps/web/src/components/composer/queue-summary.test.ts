import type { QueuedMessage } from "@OpenAde/contracts/orchestration";
import { makeItemId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "vitest";

import { queueSummary } from "@/components/composer/queue-summary";

const message = (fields: Partial<QueuedMessage>): QueuedMessage => ({
  queuedMessageId: makeItemId(),
  text: "follow-up",
  attachments: [],
  mentions: [],
  queuedAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});

describe("queueSummary", () => {
  it("has nothing to say about a text-only message", () => {
    expect(queueSummary(message({}))).toBeNull();
    expect(queueSummary(message({ references: [] }))).toBeNull();
  });

  it("reads as before for mentions and attachments", () => {
    expect(
      queueSummary(
        message({
          mentions: ["src/app.tsx"],
          attachments: [{ path: "shot.png", mime: "image/png" }],
        }),
      ),
    ).toBe("#×1 +1 file(s)");
  });

  it("counts skills and plugins under their draft tokens", () => {
    expect(
      queueSummary(
        message({
          mentions: ["src/app.tsx", "docs/a.md"],
          references: [
            { kind: "skill", name: "health-checks" },
            { kind: "plugin", name: "formatter" },
            { kind: "skill", name: "smoke-tests" },
          ],
          attachments: [{ path: "shot.png", mime: "image/png" }],
        }),
      ),
    ).toBe("#×2 $×2 @×1 +1 file(s)");
  });

  it("shows references alone", () => {
    expect(queueSummary(message({ references: [{ kind: "plugin", name: "formatter" }] }))).toBe(
      "@×1",
    );
  });
});
