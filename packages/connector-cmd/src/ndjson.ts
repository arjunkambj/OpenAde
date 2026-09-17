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

/** Splits a chunk stream into complete lines, holding a partial tail. */
export const makeLineSplitter = () => {
  let pending = "";
  return {
    push: (chunk: string): Array<string> => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      return lines.filter((line) => line.length > 0);
    },
    flush: (): string | null => (pending.length > 0 ? pending : null),
  };
};
