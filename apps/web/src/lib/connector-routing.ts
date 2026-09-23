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
 * route to, and the server's rule for that lives in
 * `apps/server/src/settings/connectorRouting.ts`, which `ConnectorSelection`
 * and the new-thread model seed both read: the first enabled connector in the
 * order the settings document lists them *that is also open*.
 * `connectors.list` answers in that same document order, so the client reads
 * the document half of the rule off it.
 *
 * It deliberately stops there. Openness is a registry fact the client cannot
 * see — `probe` is the nearest thing and it is not the same question, and a
 * probe that has not answered yet would empty the picker again, which is the
 * bug this module exists to fix. So when the first enabled connector is
 * enabled but fails to open, the picker lists its models while the turn will
 * actually run on the next one. That window is narrow and self-correcting: the
 * thread binds a session on its first turn and `bound` takes over from then on,
 * and a connector that cannot open is a connector the user has to fix anyway.
 *
 * Only for *listing* models. Capabilities stay keyed on the bound session: a
 * fresh session consumes whatever the thread's settings say, so a not-yet-bound
 * connector's `restart` switch must not lock the picker before there is
 * anything to restart.
 */

import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";
import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

export const routedConnectorInstanceId = (
  bound: ConnectorInstanceId | null | undefined,
  connectors: ReadonlyArray<ConnectorSummary>,
): ConnectorInstanceId | null =>
  bound ?? connectors.find((connector) => connector.enabled)?.connectorInstanceId ?? null;

/**
 * The capabilities of the instance a thread runs on — or would, before its
 * first turn. What the harness *is* able to do (which runtime modes it honours,
 * whether it takes images) does not wait for a session, unlike the switch
 * behaviour above. `null` until that instance has opened and reported them.
 */
export const routedCapabilities = (
  bound: ConnectorInstanceId | null | undefined,
  connectors: ReadonlyArray<ConnectorSummary>,
): ConnectorCapabilities | null => {
  const routed = routedConnectorInstanceId(bound, connectors);
  return connectors.find((c) => c.connectorInstanceId === routed)?.capabilities ?? null;
};
