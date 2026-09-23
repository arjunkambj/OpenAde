/**
 * Update-check stub. The app has no update feed and no updater: nothing in
 * the UI, the menus or the site offers updates, and electron-builder has no
 * `publish` feed. Called once at startup, it does nothing unless
 * `OPENADE_UPDATER=1`, and then it only logs that no feed is configured.
 */
export function checkForUpdates() {
  if (process.env.OPENADE_UPDATER !== "1") return;
  console.log("[updater] update checks are enabled but no feed is configured");
}
