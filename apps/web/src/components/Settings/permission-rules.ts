/**
 * How Settings → Permissions lists and edits saved permission rules.
 *
 * A rule has no id. The server's `permission_rules` table keys it by
 * (scope, project, thread, pattern), storing a missing project or thread as
 * '', and an insert that collides with that key upserts. `ruleKey` mirrors
 * that key, and every edit here finds its rule by key in the list it is
 * given, never by index: the list changes under the page whenever an
 * "allow always" answer lands, so the caller passes the latest value at click
 * time and writes the whole list back through the settings update path.
 *
 * Groups follow how far a rule reaches: global rules first, then one group
 * per project in the sidebar's project order (rules of a project that no
 * longer exists last, under "Removed project"), then one group per thread for
 * session rules. Within a group the order the rules arrived in is kept.
 */

import type { PermissionRule } from "@OpenAde/contracts/settings";
import { parsePattern } from "@OpenAde/shared/permissionPattern";

type RuleGroup = {
  readonly key: string;
  readonly scope: PermissionRule["scope"];
  readonly title: string;
  readonly rules: ReadonlyArray<PermissionRule>;
};

/** The rule's identity, the way the server's unique key sees it. */
export const ruleKey = (rule: PermissionRule): string =>
  JSON.stringify([rule.scope, rule.projectId ?? "", rule.threadId ?? "", rule.pattern]);

/** Rules keyed by `by`, in first-seen order of the key. */
const bucket = (
  rules: ReadonlyArray<PermissionRule>,
  by: (rule: PermissionRule) => string,
): Map<string, PermissionRule[]> => {
  const buckets = new Map<string, PermissionRule[]>();
  for (const rule of rules) {
    const id = by(rule);
    const list = buckets.get(id);
    if (list === undefined) {
      buckets.set(id, [rule]);
    } else {
      list.push(rule);
    }
  }
  return buckets;
};

export const groupRules = (
  rules: ReadonlyArray<PermissionRule>,
  projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>,
  threads: ReadonlyArray<{ readonly threadId: string; readonly title: string }>,
): ReadonlyArray<RuleGroup> => {
  const groups: RuleGroup[] = [];

  const global = rules.filter((rule) => rule.scope === "global");
  if (global.length > 0) {
    groups.push({ key: "global", scope: "global", title: "All projects", rules: global });
  }

  const byProject = bucket(
    rules.filter((rule) => rule.scope === "project"),
    (rule) => rule.projectId ?? "",
  );
  for (const project of projects) {
    const list = byProject.get(project.projectId);
    if (list !== undefined) {
      groups.push({
        key: `project:${project.projectId}`,
        scope: "project",
        title: project.name,
        rules: list,
      });
      byProject.delete(project.projectId);
    }
  }
  const removed = [...byProject.values()].flat();
  if (removed.length > 0) {
    groups.push({
      key: "project:removed",
      scope: "project",
      title: "Removed project",
      rules: removed,
    });
  }

  const titles = new Map(threads.map((thread) => [thread.threadId, thread.title]));
  const byThread = bucket(
    rules.filter((rule) => rule.scope === "session"),
    (rule) => rule.threadId ?? "",
  );
  for (const [threadId, list] of byThread) {
    groups.push({
      key: `session:${threadId}`,
      scope: "session",
      title: titles.get(threadId) ?? "Deleted thread",
      rules: list,
    });
  }

  return groups;
};

/** The list without `target`. */
export const withoutRule = (
  rules: ReadonlyArray<PermissionRule>,
  target: PermissionRule,
): ReadonlyArray<PermissionRule> => {
  const key = ruleKey(target);
  return rules.filter((rule) => ruleKey(rule) !== key);
};

type PatternEdit =
  | { readonly ok: true; readonly rules: ReadonlyArray<PermissionRule> }
  | { readonly ok: false; readonly reason: "invalid" | "unchanged" | "duplicate" };

/**
 * The list with `target`'s pattern replaced by `pattern` (trimmed), keeping
 * everything else about the rule. Refuses a pattern that does not parse, one
 * equal to the current pattern, and one another rule of the same scope,
 * project and thread already has — the server would fold the two into one.
 */
export const withPattern = (
  rules: ReadonlyArray<PermissionRule>,
  target: PermissionRule,
  pattern: string,
): PatternEdit => {
  const next = pattern.trim();
  if (next.length === 0 || parsePattern(next) === null) {
    return { ok: false, reason: "invalid" };
  }
  if (next === target.pattern) {
    return { ok: false, reason: "unchanged" };
  }
  const edited: PermissionRule = { ...target, pattern: next };
  const editedKey = ruleKey(edited);
  if (rules.some((rule) => ruleKey(rule) === editedKey)) {
    return { ok: false, reason: "duplicate" };
  }
  const key = ruleKey(target);
  return {
    ok: true,
    rules: rules.map((rule) => (ruleKey(rule) === key ? { ...rule, pattern: next } : rule)),
  };
};
