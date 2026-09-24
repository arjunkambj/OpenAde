/**
 * Who answers a command id right now, and what a `when` clause reads.
 *
 * The keybinding listener resolves a chord to a command id and then has to find
 * the surface that answers it. That used to be one entry per id in a plain map,
 * last writer wins — which is fine while exactly one surface claims an id, and
 * silently destroys the binding when two do.
 *
 * `SearchProvider` was mounted twice (once at the app root, once inside the
 * settings shell) and claimed the palette, new thread, skills and settings
 * commands from both. The settings copy mounted second and overwrote all four;
 * on unmount it found its own entries still installed and deleted them, and the
 * root provider's effect never re-ran — so visiting /settings once left those
 * four chords dead on every route until the window was reloaded.
 *
 * So registration is a stack per id: the newest claimant answers, and releasing
 * one hands the id back to whoever held it before rather than blanking it.
 * Releasing out of order is fine — an entry is removed by identity, wherever it
 * sits. Context flags work the same way, for the same reason: `turnRunning`
 * is published by more than one component, and an unconditional delete on the
 * first unmount dropped the flag while the other publisher was still mounted.
 *
 * Nothing here is reactive. It is read inside a keydown handler and inside the
 * palette's content, which mounts fresh on every open.
 */

/** A `when`-clause flag: read through a getter so a changed value is live. */
export type FlagValue = boolean | string;

export interface CommandRegistry {
  /** Answer `command` until the returned release is called. */
  readonly register: (command: string, handler: () => void) => () => void;
  /** The handler currently answering `command`, if any. */
  readonly resolve: (command: string) => (() => void) | undefined;
  /** Whether any mounted surface answers `command`. */
  readonly has: (command: string) => boolean;
  /** Publish a `when`-clause flag until the returned release is called. */
  readonly publish: (flag: string, read: () => FlagValue) => () => void;
  /** What a `when` clause should read for `flag`. */
  readonly flag: (flag: string) => FlagValue | undefined;
}

/** Pushes `entry`, and answers with a release that drops exactly it. */
const push = <A>(stacks: Map<string, Array<A>>, key: string, entry: A): (() => void) => {
  const stack = stacks.get(key) ?? [];
  stack.push(entry);
  stacks.set(key, stack);
  return () => {
    const current = stacks.get(key);
    if (current === undefined) {
      return;
    }
    const at = current.lastIndexOf(entry);
    if (at !== -1) {
      current.splice(at, 1);
    }
    if (current.length === 0) {
      stacks.delete(key);
    }
  };
};

/** The newest claimant, or `undefined` when nobody holds the key. */
const top = <A>(stacks: Map<string, Array<A>>, key: string): A | undefined => {
  const stack = stacks.get(key);
  return stack === undefined ? undefined : stack[stack.length - 1];
};

export const makeCommandRegistry = (): CommandRegistry => {
  const commands = new Map<string, Array<() => void>>();
  const flags = new Map<string, Array<() => FlagValue>>();
  return {
    register: (command, handler) => push(commands, command, handler),
    resolve: (command) => top(commands, command),
    has: (command) => top(commands, command) !== undefined,
    publish: (flag, read) => push(flags, flag, read),
    flag: (flag) => top(flags, flag)?.(),
  };
};
