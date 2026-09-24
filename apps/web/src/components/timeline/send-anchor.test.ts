import type { ItemKind } from "@OpenAde/contracts/enums";
import type { ItemId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "vitest";

import type { TimelineRow } from "./fold";
import {
  INITIAL_SEND_ANCHOR,
  isScrollKey,
  rowIdSet,
  sendAnchorProps,
  sendAnchorReducer,
  sentUserMessageId,
  type SendAnchorEvent,
  type SendAnchorState,
} from "./send-anchor";

const row = (id: string, kind: ItemKind = "assistant_message"): TimelineRow => ({
  kind: "item",
  id,
  item: { itemId: id as ItemId, kind, status: "completed" },
});
const user = (id: string) => row(id, "user_message");
const working: TimelineRow = { kind: "working", id: "working", startedAt: undefined };

const run = (events: ReadonlyArray<SendAnchorEvent>, from = INITIAL_SEND_ANCHOR) =>
  events.reduce(sendAnchorReducer, from);

const send = (id: string, sentHere = true): SendAnchorEvent => ({
  type: "rowsChanged",
  newUserMessageId: id,
  turnActive: true,
  sentHere,
});

const anchored: SendAnchorState = run([send("u2")]);

describe("sentUserMessageId", () => {
  const history = [user("u1"), row("a1")];

  it("never anchors on the first projection", () => {
    expect(sentUserMessageId(null, history)).toBeNull();
  });

  it("finds a user message appended after mount", () => {
    const next = [...history, user("u2"), working];
    expect(sentUserMessageId(rowIdSet(history), next)).toBe("u2");
  });

  it("ignores rows that are not a new latest user message", () => {
    expect(sentUserMessageId(rowIdSet(history), [...history, row("a2")])).toBeNull();
    expect(sentUserMessageId(rowIdSet(history), history)).toBeNull();
    // A fold opening brings rows back, never a user message that is not the latest.
    const opened = [user("u0"), ...history];
    expect(sentUserMessageId(rowIdSet(history), opened)).toBeNull();
  });
});

describe("sendAnchorReducer", () => {
  it("starts following the end, with no reserve", () => {
    expect(sendAnchorProps(INITIAL_SEND_ANCHOR)).toEqual({
      maintainScrollAtEnd: true,
      anchorRowId: null,
      reserveRowId: null,
    });
  });

  it("does not anchor on rows that carry no send", () => {
    const state = run([{ type: "rowsChanged", turnActive: true }]);
    expect(state).toBe(INITIAL_SEND_ANCHOR);
  });

  it("does not anchor on a new user message outside a turn", () => {
    const state = run([{ type: "rowsChanged", newUserMessageId: "u2", turnActive: false }]);
    expect(state).toBe(INITIAL_SEND_ANCHOR);
  });

  it("anchors a send: stops following and holds the message", () => {
    expect(anchored.mode).toBe("anchored");
    expect(sendAnchorProps(anchored)).toEqual({
      maintainScrollAtEnd: false,
      anchorRowId: "u2",
      reserveRowId: "u2",
    });
  });

  it("anchors a send made here from any mode, placing the message again", () => {
    const free = run([{ type: "userScrollIntent" }], anchored);
    const again = run([send("u3")], free);
    expect(again.mode).toBe("anchored");
    expect(again.sentRowId).toBe("u3");
    expect(again.placement).toBe(anchored.placement + 1);
  });

  it("leaves a reader who scrolled away alone for a message this window did not just send", () => {
    // A queued message drained minutes later, or one sent from another window.
    const free = run([{ type: "userScrollIntent" }], anchored);
    expect(run([send("u3", false)], free)).toBe(free);
    // Following, the list is at its end anyway, so the message is anchored.
    expect(run([send("u3", false)]).mode).toBe("anchored");
  });

  it("releases to the reader on a scroll, keeping the reserve", () => {
    const state = run([{ type: "userScrollIntent" }], anchored);
    expect(state.mode).toBe("free");
    expect(sendAnchorProps(state)).toEqual({
      maintainScrollAtEnd: false,
      anchorRowId: null,
      reserveRowId: "u2",
    });
  });

  it("ignores scrolls while following", () => {
    expect(run([{ type: "userScrollIntent" }])).toBe(INITIAL_SEND_ANCHOR);
  });

  it("resumes following when the reader reaches the end", () => {
    const state = run([{ type: "userScrollIntent" }, { type: "reachedEnd" }], anchored);
    expect(state.mode).toBe("follow");
    expect(sendAnchorProps(state).maintainScrollAtEnd).toBe(true);
    expect(sendAnchorProps(state).reserveRowId).toBe("u2");
  });

  it("stays anchored at the end the reserve makes", () => {
    expect(run([{ type: "reachedEnd" }], anchored)).toBe(anchored);
  });

  it("resumes following on a jump, from any mode", () => {
    expect(run([{ type: "jumpToLatest" }], anchored).mode).toBe("follow");
    const free = run([{ type: "userScrollIntent" }], anchored);
    expect(run([{ type: "jumpToLatest" }], free).mode).toBe("follow");
    expect(run([{ type: "jumpToLatest" }])).toBe(INITIAL_SEND_ANCHOR);
  });

  it("keeps the anchor when the turn settles, placing it again without a jump", () => {
    const state = run([{ type: "turnSettled" }], anchored);
    expect(state.mode).toBe("anchored");
    expect(state.sentRowId).toBe("u2");
    expect(state.placement).toBe(anchored.placement + 1);
    // Only the reader's scroll lets go of it.
    expect(run([{ type: "userScrollIntent" }], state).mode).toBe("free");
  });

  it("leaves a settle alone outside the anchor", () => {
    const free = run([{ type: "userScrollIntent" }], anchored);
    expect(run([{ type: "turnSettled" }], free)).toBe(free);
    expect(run([{ type: "turnSettled" }])).toBe(INITIAL_SEND_ANCHOR);
  });
});

describe("isScrollKey", () => {
  it("knows the keys that scroll a focused list", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown"]) {
      expect(isScrollKey(key)).toBe(true);
    }
    for (const key of ["a", "Enter", "Escape", "ArrowLeft", "Tab"]) {
      expect(isScrollKey(key)).toBe(false);
    }
  });
});
