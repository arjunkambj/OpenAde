/**
 * Auto-update stub: no feed is configured yet, so this is a no-op unless
 * `OPENADE_UPDATER=1` — at which point it logs the intent. The real wiring
 * lands with the release pipeline.
 */
export function checkForUpdates() {
  if (process.env.OPENADE_UPDATER !== "1") return;
  console.log("[updater] update checks are enabled but no feed is configured");
}
