/**
 * The `data-desktop*` attributes the preload stamps on `<html>`.
 *
 * `packages/ui` keys its shell styles off them — the traffic-light inset, the
 * draggable title area — so which ones a platform gets is an OS decision, and
 * spec section 01 keeps OS decisions in this folder. The preload asks; it does
 * not test `process.platform` itself.
 */
export const desktopAttributes = (platform: string): ReadonlyArray<string> =>
  platform === "darwin" ? ["data-desktop", "data-desktop-mac"] : ["data-desktop"];
