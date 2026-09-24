/**
 * Coalesces a pty's output into batches, so a shell writing a byte at a time
 * does not become a frame per byte on the wire.
 *
 * A batch goes out `delayMs` after the first chunk that started it, or at once
 * when it reaches `maxChars`. A batch never exceeds `maxChars`, and never ends
 * between the two halves of a surrogate pair. One timer per batcher, cleared
 * on `dispose`. `flush` is called synchronously from `push` or the timer.
 */
import { TERMINAL_BATCH_CHARS, TERMINAL_BATCH_MS } from "@poseidon/contracts/terminal";

/** The two timer calls the batcher makes; a test passes one it advances by hand. */
export interface BatchScheduler {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const realScheduler: BatchScheduler = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BatcherOptions {
  readonly flush: (data: string) => void;
  readonly maxChars?: number;
  readonly delayMs?: number;
  readonly scheduler?: BatchScheduler;
}

export interface Batcher {
  readonly push: (data: string) => void;
  /** Send whatever is pending now — before an `exited`, so the last output precedes it. */
  readonly drain: () => void;
  /** Stop the timer and drop anything pending. Later pushes are ignored. */
  readonly dispose: () => void;
}

export const makeBatcher = (options: BatcherOptions): Batcher => {
  const maxChars = options.maxChars ?? TERMINAL_BATCH_CHARS;
  const delayMs = options.delayMs ?? TERMINAL_BATCH_MS;
  const scheduler = options.scheduler ?? realScheduler;
  let pending = "";
  let timer: unknown = undefined;
  let disposed = false;

  const stopTimer = () => {
    if (timer === undefined) return;
    scheduler.clear(timer);
    timer = undefined;
  };

  const emit = (data: string) => {
    if (data !== "") options.flush(data);
  };

  const drain = () => {
    stopTimer();
    const data = pending;
    pending = "";
    emit(data);
  };

  return {
    push: (data) => {
      if (disposed || data === "") return;
      pending += data;
      while (pending.length >= maxChars) {
        const cut = splitPoint(pending, maxChars);
        const batch = pending.slice(0, cut);
        pending = pending.slice(cut);
        emit(batch);
      }
      if (pending === "") stopTimer();
      else if (timer === undefined) {
        timer = scheduler.set(() => {
          timer = undefined;
          drain();
        }, delayMs);
      }
    },
    drain: () => {
      if (!disposed) drain();
    },
    dispose: () => {
      disposed = true;
      stopTimer();
      pending = "";
    },
  };
};

/** `maxChars`, or one less when that would split a surrogate pair. */
const splitPoint = (text: string, maxChars: number): number => {
  const before = text.charCodeAt(maxChars - 1);
  return maxChars > 1 && before >= 0xd800 && before <= 0xdbff ? maxChars - 1 : maxChars;
};
