/**
 * The `data-desktop*` attributes the preload stamps on `<html>`.
 *
 * `packages/ui` keys its shell styles off them — the traffic-light inset, the
 * draggable title area — so which ones a platform gets is an OS decision, and
 * the shell keeps its OS decisions in this folder. The preload asks; it does
 * not test `process.platform` itself.
 */
export const desktopAttributes = (platform: string): ReadonlyArray<string> =>
  platform === "darwin" ? ["data-desktop", "data-desktop-mac"] : ["data-desktop"];

/**
 * Set on `<html>` while the window is fullscreen. macOS hides the traffic
 * lights there, so the inset reserved for them has to go too.
 */
export const FULLSCREEN_ATTRIBUTE = "data-fullscreen";

/** Main-to-preload channel carrying the window's fullscreen state. */
export const FULLSCREEN_CHANNEL = "poseidon:fullscreen";
