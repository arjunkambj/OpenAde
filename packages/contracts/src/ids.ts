/**
 * Identifiers on the wire.
 *
 * Every identifier Poseidon mints is a UUIDv7 string (see `@poseidon/shared/ids`
 * for why), branded so that a `ThreadId` can never be passed where a `TurnId`
 * is expected. The schemas validate the UUIDv7 shape on decode, so a malformed
 * id fails at the transport boundary rather than deep inside a projection.
 *
 * `ConnectorKind` is deliberately an unconstrained string: connectors are
 * discovered at runtime, and a literal union here would mean the contracts
 * package has to change every time one is added.
 */

import { isUuidV7, uuidV7 } from "@poseidon/shared/ids";
import * as Schema from "effect/Schema";

/** A lower-case UUIDv7 string, unbranded. */
export const UuidV7 = Schema.String.check(
  Schema.makeFilter((value: string) => isUuidV7(value), {
    identifier: "UuidV7",
    title: "a lower-case UUIDv7 string",
  }),
);
export type UuidV7 = typeof UuidV7.Type;

/**
 * Defines one branded id schema together with the two helpers every caller
 * needs: `make` for a fresh id and `decode` for an id arriving from outside.
 */
const defineId = <Brand extends string>(brand: Brand) => {
  const schema = UuidV7.pipe(Schema.brand(brand));
  const decode = Schema.decodeUnknownSync(schema);
  const make = (): typeof schema.Type => decode(uuidV7());
  return [schema, make, decode] as const;
};

export const [ProjectId, makeProjectId, decodeProjectId] = defineId("ProjectId");
export type ProjectId = typeof ProjectId.Type;

export const [ThreadId, makeThreadId, decodeThreadId] = defineId("ThreadId");
export type ThreadId = typeof ThreadId.Type;

export const [TurnId, makeTurnId, decodeTurnId] = defineId("TurnId");
export type TurnId = typeof TurnId.Type;

export const [ItemId, makeItemId, decodeItemId] = defineId("ItemId");
export type ItemId = typeof ItemId.Type;

export const [RequestId, makeRequestId, decodeRequestId] = defineId("RequestId");
export type RequestId = typeof RequestId.Type;

export const [EventId, makeEventId, decodeEventId] = defineId("EventId");
export type EventId = typeof EventId.Type;

export const [CommandId, makeCommandId, decodeCommandId] = defineId("CommandId");
export type CommandId = typeof CommandId.Type;

export const [ConnectorInstanceId, makeConnectorInstanceId, decodeConnectorInstanceId] =
  defineId("ConnectorInstanceId");
export type ConnectorInstanceId = typeof ConnectorInstanceId.Type;

export const [CheckpointId, makeCheckpointId, decodeCheckpointId] = defineId("CheckpointId");
export type CheckpointId = typeof CheckpointId.Type;

/** Minted by the client, so opening a terminal is idempotent and a reattach is by id. */
export const [TerminalId, makeTerminalId, decodeTerminalId] = defineId("TerminalId");
export type TerminalId = typeof TerminalId.Type;

/**
 * Which connector a session runs on. Opaque on purpose: never a literal union,
 * and no kind is named here, so adding a connector never touches this package.
 */
export const ConnectorKind = Schema.String;
export type ConnectorKind = typeof ConnectorKind.Type;
