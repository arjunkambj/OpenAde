/**
 * The stdout contract of `cmd -p --output-format json` (spec 5.2): one JSON
 * object per line, `{"type":"event","event":{...}}` except the final
 * `{"type":"result",...}` line. Only the fields the translator needs are
 * typed — everything else stays on the frame for `event.unmapped` raw.
 */

export interface CmdEventFrame {
  readonly type: "event";
  readonly event: {
    readonly type: string;
    readonly sessionId?: string;
    readonly turnNumber?: number;
    readonly model?: string;
    readonly traceId?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly description?: string;
    readonly error?: { readonly name?: string; readonly message?: string };
    readonly result?: {
      readonly finalText?: string;
      readonly stopReason?: string;
      readonly turnCount?: number;
      readonly usage?: CmdUsage;
      readonly nextState?: { readonly sessionId?: string };
    };
    readonly [key: string]: unknown;
  };
}

export interface CmdResultFrame {
  readonly type: "result";
  readonly subtype?: string;
  readonly sessionId?: string;
  readonly usage?: CmdUsage;
  readonly durationMs?: number;
  readonly finalText?: string;
  readonly error?: string;
}

export interface CmdUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type CmdFrame = CmdEventFrame | CmdResultFrame;

export interface CmdFrameParseError {
  readonly line: string;
  readonly message: string;
}

/**
 * One stdout line → one frame, or a parse error the caller turns into
 * `event.unmapped`. A line that is JSON but not a known envelope is an error
 * too — dropping it silently would hide a protocol change.
 */
export const parseFrame = (line: string): CmdFrame | CmdFrameParseError => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { line, message: "not JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { line, message: "not an object" };
  }
  const type = (value as { type?: unknown }).type;
  if (type === "event" || type === "result") {
    return value as CmdFrame;
  }
  return { line, message: `unknown frame type ${String(type)}` };
};

/**
 * The largest unterminated line the splitter will hold.
 *
 * Most frames are a couple of kilobytes, but `run_end` is not: it carries
 * `result.nextState.messages` — the whole conversation, content blocks and all
 * — and `fixtures/cmd/image/` shows those include the harness's base64 image
 * block. Every later turn of a session replays that history, so once a
 * screenshot is in a thread each `run_end` grows by the transcoded bytes, and
 * at a one-megabyte cap the line was silently dropped: the `nextState`
 * reconcile and the final `usage.updated` were lost for that turn and for
 * every turn after it, because the image stays in the replayed history.
 *
 * So the ceiling is high enough for a conversation with images in it, and it
 * still exists — a peer that never sends a newline must not grow the buffer
 * forever.
 */
export const MAX_LINE_CHARS = 32 * 1024 * 1024;

/** How much of a dropped line is kept, so the warning can name the frame. */
const OVERFLOW_HEAD_CHARS = 200;

export interface SplitPush {
  /** Complete `\n`-terminated lines in this chunk, in order. */
  readonly lines: ReadonlyArray<string>;
  /** Set when the unterminated tail exceeded the cap and was dropped. */
  readonly overflow: { readonly droppedChars: number; readonly head: string } | null;
}

/** Splits a chunk stream into complete lines, holding a bounded partial tail. */
export const makeLineSplitter = () => {
  let pending = "";
  /** Past the cap: everything up to the next newline belongs to the dropped line. */
  let dropping = false;
  return {
    push: (chunk: string): SplitPush => {
      let text = chunk;
      if (dropping) {
        const newline = text.indexOf("\n");
        if (newline === -1) {
          // Still inside the line we gave up on; emitting its tail as a frame
          // would only surface a truncated fragment.
          return { lines: [], overflow: null };
        }
        dropping = false;
        text = text.slice(newline + 1);
      }
      pending += text;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      let overflow: SplitPush["overflow"] = null;
      if (pending.length > MAX_LINE_CHARS) {
        overflow = {
          droppedChars: pending.length,
          head: pending.slice(0, OVERFLOW_HEAD_CHARS),
        };
        pending = "";
        dropping = true;
      }
      return { lines: parts.filter((line) => line.length > 0), overflow };
    },
    /** The unterminated tail, if any — the last frame may lack its newline. */
    flush: (): string | null => {
      const tail = pending;
      pending = "";
      return tail.length > 0 ? tail : null;
    },
  };
};
