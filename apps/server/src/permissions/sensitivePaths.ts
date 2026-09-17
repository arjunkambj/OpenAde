/**
 * Paths a permission decision always asks about.
 *
 * The list is deliberately about *credentials and secrets*, not about being
 * cautious in general — `.env` files, key material, SSH and cloud credentials,
 * password stores. "full-access" allows everything *except* these, so the
 * check sits below the runtime-mode shortcut in the ladder.
 */

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];

const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);

const normalize = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");

export const isSensitivePath = (path: string): boolean => {
  const normalized = normalize(path);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (basename === "" || basename === "." || basename === "..") {
    return false;
  }
  if (SENSITIVE_BASENAMES.has(basename) || basename.startsWith(".env.")) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return true;
  }
  const lowered = segments.map((segment) => segment.toLowerCase());
  if (lowered.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    return true;
  }
  // `.config/gh` is a two-segment match — hosts.yml holds tokens.
  return lowered.some((segment, index) => segment === ".config" && lowered[index + 1] === "gh");
};
