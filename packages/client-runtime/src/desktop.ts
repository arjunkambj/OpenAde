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

const bridge = () => (typeof window === "undefined" ? undefined : window.openade);

/**
 * `null` means "no desktop shell here". Seeded from `getServerState()` and
 * then driven by `onServerState`, with the subscription torn down when the
 * last subscriber goes away.
 *
 * @public The desktop shell's connection banner reads this.
 */
export const desktopServerStateAtom = Atom.make<DesktopServerState | null>((get) => {
  const openade = bridge();
  if (openade?.onServerState === undefined) {
    return null;
  }
  get.addFinalizer(openade.onServerState((state) => get.setSelf(state)));
  if (openade.getServerState !== undefined) {
    // The subscription only pushes transitions, so the current value has to be
    // asked for. A preload that throws here just leaves the atom at null.
    void Promise.resolve(openade.getServerState())
      .then((state) => get.setSelf(state))
      .catch(() => undefined);
  }
  return null;
});
