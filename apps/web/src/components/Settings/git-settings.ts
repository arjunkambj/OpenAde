/**
 * The pure half of the Git & worktrees page: what a draft saves as, and
 * whether it saves at all.
 *
 * `settings.update` replaces each key it carries, so a setup script is saved
 * by writing the whole `projectSettings` record — built here from the latest
 * one, so saving one project's script never drops another's.
 */

import type { ProjectSettings } from "@OpenAde/contracts/settings";

type ProjectSettingsRecord = { readonly [projectId: string]: ProjectSettings };

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/**
 * Why `prefix` cannot start a branch name, or null when it can. The server has
 * the last word (`git check-ref-format` when a worktree is created); this
 * catches the common mistakes while the user is still on the page. An empty
 * prefix is allowed: the branch is then the slug alone.
 */
export const prefixProblem = (prefix: string): string | null => {
  if (prefix.startsWith("-")) {
    return "A branch prefix can't start with “-”.";
  }
  if (prefix.startsWith("/") || prefix.includes("//")) {
    return "A branch prefix can't start with “/” or hold “//”.";
  }
  if (/\s/.test(prefix)) {
    return "A branch prefix can't hold spaces.";
  }
  if (prefix.includes("..") || prefix.includes("@{")) {
    return "A branch prefix can't hold “..” or “@{”.";
  }
  if (/[~^:?*[\\]/.test(prefix) || [...prefix].some(isControl)) {
    return "A branch prefix can't hold ~ ^ : ? * [ or \\.";
  }
  return null;
};

/** The prefix a draft saves as, or null when saving would change nothing. */
export const prefixToSave = (current: string, draft: string): string | null => {
  const next = draft.trim();
  return next === current ? null : next;
};

/**
 * The `projectSettings` record with `projectId`'s script set to `draft`, or
 * null when the saved script is already that. A blank draft removes the
 * script, and a project left with no settings leaves the record entirely.
 */
export const withSetupScript = (
  current: ProjectSettingsRecord,
  projectId: string,
  draft: string,
): ProjectSettingsRecord | null => {
  const script = draft.trim();
  const own = current[projectId];
  if ((own?.setupScript ?? "") === script) {
    return null;
  }
  const { setupScript: _dropped, ...rest } = own ?? {};
  const next: ProjectSettings = script === "" ? rest : { ...rest, setupScript: script };
  const { [projectId]: _old, ...others } = current;
  return Object.keys(next).length === 0 ? others : { ...others, [projectId]: next };
};
