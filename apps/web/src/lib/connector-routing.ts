/**
 * Which connector instance a thread's models come from.
 *
 * A thread binds a session only on its first `thread.turn.requested`, so before
 * the first turn `doc.session` is null. The header picker and the composer's
 * `/model` menu both asked `connectorModelsAtom` for that null instance, which
 * short-circuits to an empty list — so on a brand-new thread the Model picker
 * held exactly one entry, the raw id of the current model, and `/model` read
 * "No options". Both filled in the moment a message was sent, which is after
 * the point where choosing a model is useful.
 *
 * Until a session exists, the honest answer is the instance the thread *would*
 * route to, and the server has one rule for that: the first enabled connector
 * in the order the settings document lists them
 * (`apps/server/src/settings/connectorRouting.ts`, which `ConnectorSelection`
 * and the new-thread model seed both read). `connectors.list` answers in that
 * same document order, so the client can read the same rule off it.
 *
 * Only for *listing* models. Capabilities stay keyed on the bound session: a
 * fresh session consumes whatever the thread's settings say, so a not-yet-bound
 * connector's `restart` switch must not lock the picker before there is
 * anything to restart.
 */

import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";

export const routedConnectorInstanceId = (
  bound: ConnectorInstanceId | null | undefined,
  connectors: ReadonlyArray<ConnectorSummary>,
): ConnectorInstanceId | null =>
  bound ?? connectors.find((connector) => connector.enabled)?.connectorInstanceId ?? null;
