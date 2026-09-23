/**
 * The user messages a session feeds the SDK, as the async iterable its
 * streaming-input mode reads.
 *
 * `query({ prompt })` with an iterable keeps one CLI process alive for the
 * whole session: each value the iterable yields is one user message written to
 * the CLI's stdin, and the process lives until the iterable finishes. So the
 * queue is the session's lifeline as well as its mailbox — `push` delivers a
 * message whenever it is called, including while a turn is running, and `end`
 * is what lets the CLI exit cleanly.
 *
 * One reader only: the SDK iterates the prompt exactly once.
 */

export interface InputQueue<A> {
  /** Delivers one message; false once the queue has ended. */
  readonly push: (message: A) => boolean;
  /** Finishes the iterable. Messages already pushed are still delivered. */
  readonly end: () => void;
  readonly ended: () => boolean;
  readonly iterable: AsyncIterable<A>;
}

export const makeInputQueue = <A>(): InputQueue<A> => {
  const buffered: Array<A> = [];
  let finished = false;
  /** The reader parked on an empty queue, if there is one. */
  let waiting: ((result: IteratorResult<A>) => void) | null = null;

  const wake = (): void => {
    if (waiting === null) return;
    const resolve = waiting;
    if (buffered.length > 0) {
      waiting = null;
      resolve({ done: false, value: buffered.shift()! });
    } else if (finished) {
      waiting = null;
      resolve({ done: true, value: undefined });
    }
  };

  const iterator: AsyncIterator<A> = {
    next: () =>
      new Promise<IteratorResult<A>>((resolve) => {
        if (buffered.length > 0) {
          resolve({ done: false, value: buffered.shift()! });
        } else if (finished) {
          resolve({ done: true, value: undefined });
        } else {
          waiting = resolve;
        }
      }),
    // The SDK returns the iterator when the query closes; nothing more is read.
    return: () => {
      finished = true;
      buffered.length = 0;
      wake();
      return Promise.resolve({ done: true, value: undefined });
    },
  };

  return {
    push: (message) => {
      if (finished) return false;
      buffered.push(message);
      wake();
      return true;
    },
    end: () => {
      finished = true;
      wake();
    },
    ended: () => finished,
    iterable: { [Symbol.asyncIterator]: () => iterator },
  };
};
