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

/**
 * Directories whose whole contents count. The harness config homes are here
 * because they hold auth tokens and the harness's own permission settings — a
 * tool call rewriting them could grant itself more than the user did.
 */
const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".git",
  ".commandcode",
  ".claude",
  ".codex",
]);

/** `.config/<name>` homes, matched as two consecutive segments. */
const SENSITIVE_CONFIG_DIRS = new Set(["gh", "opencode"]);

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
  // `.env*` — the prefix match also covers `.envrc`,
  // which the exact/extension forms miss.
  if (SENSITIVE_BASENAMES.has(basename) || basename.startsWith(".env")) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return true;
  }
  const lowered = segments.map((segment) => segment.toLowerCase());
  if (lowered.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    return true;
  }
  // `.config/gh` and `.config/opencode` are two-segment matches — gh's
  // hosts.yml holds tokens, the other is a harness config home.
  return lowered.some(
    (segment, index) =>
      segment === ".config" && SENSITIVE_CONFIG_DIRS.has(lowered[index + 1] ?? ""),
  );
};

/**
 * Whether a command line names a sensitive path anywhere in its arguments.
 *
 * `cat ~/.ssh/id_rsa` and `cp .env /tmp` read secrets just as surely as a
 * `file_read` request does, and a sensitive path always prompts — so the
 * check cannot be limited to file-kind requests. Splitting on
 * shell separators and quotes is deliberately rough: this decides whether to
 * *ask*, and asking about one argument too many costs a keystroke.
 */
export const commandTouchesSensitivePath = (command: string): boolean =>
  command
    .split(/[\s;|&<>()`]+/)
    .map((token) => token.replace(/^["']+/, "").replace(/["']+$/, ""))
    .some((token) => token.length > 0 && isSensitivePath(token));
