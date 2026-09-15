/**
 * The handful of primitive wire schemas every other contract module builds on.
 *
 * Kept separate from `ids.ts` so that the id module stays about identity alone,
 * and separate from the domain modules so that "a non-empty string" means the
 * same thing in a runtime event, an orchestration event and a settings field.
 */

import * as Schema from "effect/Schema";

/**
 * A string with something in it. Used wherever an empty value would be a bug
 * rather than a legitimate "nothing here" — a tool name, a file path, a model
 * id. Text that may legitimately be empty (assistant output, a diff) stays
 * `Schema.String`.
 */
export const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
export type NonEmptyString = typeof NonEmptyString.Type;

/** A count: token usage, a byte size, a sequence number. Never negative. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type NonNegativeInt = typeof NonNegativeInt.Type;

/**
 * An ISO-8601 instant as a string. The wire carries timestamps as text so that
 * JSON fixtures, SQLite rows and the renderer all read the same bytes; parsing
 * into a `Date` is the consumer's business.
 */
export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/** An arbitrary JSON object, for payloads this package deliberately does not model. */
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
export type UnknownRecord = typeof UnknownRecord.Type;
