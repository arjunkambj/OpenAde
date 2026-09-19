/**
 * Which release channel this build is, and the two identities that have to
 * agree with `electron-builder.config.cjs`.
 *
 * `scripts/build.mjs` substitutes `process.env.OPENADE_CHANNEL` at bundle time
 * from the same `--channel` flag electron-builder is given, so the runtime can
 * name itself the way the installer named it. Getting this wrong is not
 * cosmetic: `app.setName` decides the userData directory (and with it the
 * window state and the SQLite database), and on Windows the app-user-model id
 * decides taskbar grouping and notification attribution — a canary that keeps
 * the stable name shares one and splits the other.
 */

export type Channel = "stable" | "canary";

/** Anything that is not the canary build is the stable build. */
export const resolveChannel = (raw: string | undefined): Channel =>
  raw === "canary" ? "canary" : "stable";

/** Must equal `productName` in `electron-builder.config.cjs`. */
export const productName = (channel: Channel): string =>
  channel === "canary" ? "OpenAde Canary" : "OpenAde";

/** Must equal `appId` in `electron-builder.config.cjs`. */
export const appUserModelId = (channel: Channel): string =>
  channel === "canary" ? "dev.openade.OpenAde.desktop.canary" : "dev.openade.OpenAde.desktop";
