/**
 * The desktop shell's side of the connection story, as an atom.
 *
 * `connectionStateAtom` says whether the socket is up; this says what the
 * supervisor is doing with the server process behind it. The two together are
 * what the banner needs to tell "the server is restarting, hold on" apart from
 * "nothing is listening and nothing is coming".
 *
 * Under a plain browser tab there is no bridge and the atom stays `null`,
 * which is the banner's cue to fall back to the socket state alone.
 */

import * as Atom from "effect/unstable/reactivity/Atom";

import type { DesktopServerState } from "./resolver";

const bridge = () => (typeof window === "undefined" ? undefined : window.poseidon);

/**
 * `null` means "no desktop shell here". Seeded from `getServerState()` and
 * then driven by `onServerState`, with the subscription torn down when the
 * last subscriber goes away.
 *
 * @public The desktop shell's connection banner reads this.
 */
export const desktopServerStateAtom = Atom.make<DesktopServerState | null>((get) => {
  const poseidon = bridge();
  if (poseidon?.onServerState === undefined) {
    return null;
  }
  let mounted = true;
  const unsubscribe = poseidon.onServerState((state) => get.setSelf(state));
  get.addFinalizer(() => {
    mounted = false;
    unsubscribe();
  });
  if (poseidon.getServerState !== undefined) {
    // The subscription only pushes transitions, so the current value has to be
    // asked for. A preload that throws here just leaves the atom at null, and
    // an unmount that wins the race must not write into a dead node.
    void Promise.resolve(poseidon.getServerState())
      .then((state) => {
        if (mounted) {
          get.setSelf(state);
        }
      })
      .catch(() => undefined);
  }
  return null;
});
