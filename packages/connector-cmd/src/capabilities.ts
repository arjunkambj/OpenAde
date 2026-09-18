/**
 * What a Command Code session can do, as the engine and the renderer read it.
 *
 * Its own module because both the definition and the session need it, and the
 * session file has no room left to be the place a constant lives.
 */

import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

export const CMD_CAPABILITIES: ConnectorCapabilities = {
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering: false,
  planMode: true,
  subagents: true,
  // Print mode has no image flag; the connector stages the files and names
  // their paths in the prompt instead (decision W10).
  images: true,
  resume: true,
  fork: true,
};
