/**
 * Which connector instances the Customize page shows a section for. Skills
 * and MCP servers live in each harness's own files, so every enabled instance
 * whose summary says it manages that kind gets a section of its own, in the
 * connectors page's order. A disabled or unopened instance manages nothing.
 */

import type { ConnectorSummary } from "@poseidon/contracts/connectors";

/** The kinds the Customize page has a tab for; plugins are read by the composer alone. */
export type ExtensionKind = Extract<keyof ConnectorSummary["extensions"], "skills" | "mcpServers">;

export const instancesWith = (
  connectors: ReadonlyArray<ConnectorSummary>,
  kind: ExtensionKind,
): ReadonlyArray<ConnectorSummary> =>
  connectors.filter((connector) => connector.enabled && connector.extensions[kind]);

/**
 * The tab count: every instance's list added up, or `null` until each one
 * has answered — a partial sum would read as a real, smaller count.
 */
export const totalCount = (lengths: ReadonlyArray<number | null>): number | null =>
  lengths.some((length) => length === null)
    ? null
    : lengths.reduce<number>((sum, length) => sum + (length ?? 0), 0);
