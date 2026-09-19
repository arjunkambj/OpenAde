/**
 * Quitting without orphaning the server.
 *
 * `before-quit` used to signal the supervisor and let Electron exit, but the
 * server does not die on the spot: it closes every open session first, each
 * bounded by its own timeout and each spawning `cmd mcp remove`. The main
 * process was gone long before that finished, so the child — spawned without
 * `detached`, and so nobody's to reap — was reparented and left running,
 * holding `~/.openade/state.sqlite` against the next launch.
 *
 * So the quit holds itself open: `preventDefault`, wait for the child to
 * exit, then `app.exit()`. The wait is bounded, because a wedged server must
 * not make the app unquittable, and a second quit while we wait falls
 * straight through to Electron.
 *
 * Electron-free so the sequence is unit-testable; `main/index.ts` wires the
 * real `app` to it.
 */

/** The part of `Electron.Event` this handler uses. */
export interface QuitEvent {
  preventDefault: () => void;
}

export interface QuitDeps {
  /** `ServerSupervisor.stop()` — resolves when the child is gone. */
  readonly stopServer: () => Promise<void>;
  /** Hide the windows so the app looks quit while the server winds down. */
  readonly onWaiting: () => void;
  /** `app.exit()`. */
  readonly exit: () => void;
  /** How long to wait for the child before exiting anyway. */
  readonly deadlineMs: number;
}

export const makeQuitHandler = (deps: QuitDeps): ((event: QuitEvent) => void) => {
  let quitting = false;
  return (event: QuitEvent) => {
    // The escape hatch: quit again and Electron quits, wedged server or not.
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    deps.onWaiting();

    let exited = false;
    const exitOnce = () => {
      if (exited) return;
      exited = true;
      clearTimeout(deadline);
      deps.exit();
    };
    const deadline = setTimeout(exitOnce, deps.deadlineMs);
    void deps.stopServer().then(exitOnce, exitOnce);
  };
};
