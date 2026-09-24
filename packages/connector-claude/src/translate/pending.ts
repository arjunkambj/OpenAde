/**
 * What the translator produces, and the readers it reads SDK messages with.
 *
 * The SDK's message union grows with nearly every release — the recordings
 * already carry `command_lifecycle`, which the union does not name — so the
 * translator reads messages as plain records and names only the fields it
 * uses. A field it does not find is treated as absent, never as a crash.
 */

import type { RuntimeEvent } from "@poseidon/contracts/runtime";

/** A `RuntimeEvent` minus the envelope fields the session stamps on the way out. */
type WithoutEnvelope<Event> = Event extends RuntimeEvent
  ? Omit<Event, "eventId" | "connectorInstanceId" | "threadId" | "createdAt">
  : never;

export type PendingRuntimeEvent = WithoutEnvelope<RuntimeEvent>;

/** Where every `raw` this connector attaches comes from. */
export const RAW_SOURCE = "claude.sdk";

export type Json = Readonly<Record<string, unknown>>;

export const asRecord = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

/** A non-negative integer, for the token counts the contract requires. */
export const tokens = (value: unknown): number => Math.max(0, Math.trunc(asNumber(value) ?? 0));

/** `type`, then `/subtype` when there is one — how an unmapped message is named. */
export const methodOf = (message: Json): string => {
  const type = asString(message.type) ?? "unknown";
  const subtype = asString(message.subtype) ?? asString(asRecord(message.event).type);
  return subtype === undefined ? type : `${type}/${subtype}`;
};

/** The message kept whole, so a harness change shows up instead of vanishing. */
export const unmapped = (message: Json): PendingRuntimeEvent => ({
  type: "event.unmapped",
  payload: {},
  raw: { source: RAW_SOURCE, method: methodOf(message), payload: message },
});
