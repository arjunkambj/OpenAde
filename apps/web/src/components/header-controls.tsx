/**
 * The thread header controls: model, effort, runtime mode and interaction
 * mode pickers. Every pick is a `thread.settings.update` dispatch — the doc
 * updates when `thread.settings.updated` lands, and a rejected or unreachable
 * dispatch says so beside the pickers instead of letting the value snap back
 * with no explanation.
 *
 * Capability wiring: a `restart` switch disables the picker
 * with a tooltip; `per-turn` adds an "applies next turn" hint; plan mode
 * disappears from the interaction picker when the connector cannot plan. A
 * thread with no bound session reports no capabilities, in which case model
 * and effort behave as per-turn — that is what a fresh session consumes. The
 * model picker lists every enabled instance's models (`./model-picker`); the
 * instance the thread runs on, or would (`@/lib/connector-routing`), decides
 * which section is current and which runtime modes are on offer
 * (`@/lib/runtime-modes`). Once the thread has run anything, the other
 * sections are disabled. Efforts read lowest first in the contract's order
 * (`@/lib/efforts`).
 *
 * Keys: `ThreadSettingsKeys` (`./thread-settings-keys`) answers plan mode
 * (Shift+Tab in the composer), the runtime-mode cycle, the pickers and the
 * effort steps through the same `onChange` a click uses; the pickers are
 * controlled here so a key can open them.
 */

import { Button } from "@OpenAde/ui/components/button";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@OpenAde/ui/components/tooltip";
import type { ConnectorModels } from "@OpenAde/client-runtime/connectorAtoms";
import { DEFAULT_RUNTIME_MODE, type Effort, RuntimeMode } from "@OpenAde/contracts/enums";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ConnectorInstanceId, ThreadId } from "@OpenAde/contracts/ids";
import { threadLocksConnector, type ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";
import type { CapabilitySwitch } from "@OpenAde/contracts/runtime";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import { instanceCapabilities, threadConnectorInstanceId } from "@/lib/connector-routing";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { orderEfforts } from "@/lib/efforts";
import { findModel, modelPickPatch } from "@/lib/model-picks";
import { RUNTIME_MODE_LABELS, runtimeModeOptions } from "@/lib/runtime-modes";
import { CommandKbd } from "@/lib/shortcuts";
import { Lightning, ListChecks, Lock } from "@honeyicons/react";

import { type HeaderOption, HeaderSelect, NEXT_TURN_HINT, RESTART_TOOLTIP } from "./header-select";
import { ThreadSettingsKeys } from "./thread-settings-keys";
import { ModelPicker } from "./model-picker";

export function HeaderControls({
  threadId,
  className,
}: {
  readonly threadId: ThreadId;
  readonly className?: string;
}) {
  const { threadDetailAtom, connectorsAtom, modelCatalogAtom, dispatchAtom } = useClientRuntime();
  const docResult = useAtomValue(threadDetailAtom(threadId));
  const doc = AsyncResult.isSuccess(docResult) ? docResult.value : null;
  const connectorsResult = useAtomValue(connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  // Capabilities are the *bound* session's: a thread with none behaves as
  // per-turn, because that is what a fresh session consumes.
  const boundInstanceId = doc?.session?.connectorInstanceId ?? null;
  const capabilities =
    connectors.find((c) => c.connectorInstanceId === boundInstanceId)?.capabilities ?? null;
  // Which section of the model picker is the thread's, though, is the
  // instance it runs on or *would* — see `@/lib/connector-routing` — and what
  // that harness can honour is known before any session is bound.
  const instanceId = threadConnectorInstanceId(
    boundInstanceId,
    doc?.settings.connectorInstanceId,
    connectors,
  );
  const catalogResult = useAtomValue(modelCatalogAtom);
  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
  const runtimeModes = runtimeModeOptions(instanceCapabilities(instanceId, connectors));

  const [error, setError] = React.useState<string | null>(null);

  const update = React.useCallback(
    (patch: ThreadSettingsPatch) => {
      setError(null);
      void dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.settings.update",
        threadId,
        ...patch,
      }).then(
        (receipt) => setError(receiptError(receipt, "the server rejected the change")),
        () => setError(DISPATCH_UNREACHABLE),
      );
    },
    [dispatch, threadId],
  );

  if (doc === null) {
    return null;
  }

  return (
    <div className={className}>
      <ThreadSettingsControls
        settings={doc.settings}
        catalog={catalog}
        connectorInstanceId={instanceId}
        locked={threadLocksConnector(doc)}
        modelSwitch={capabilities?.modelSwitch ?? "per-turn"}
        effortSwitch={capabilities?.effortSwitch ?? "per-turn"}
        canPlan={capabilities?.planMode ?? true}
        runtimeModes={runtimeModes}
        onChange={update}
      />
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ThreadSettingsControls({
  settings,
  catalog,
  connectorInstanceId,
  locked = false,
  modelSwitch = "next-turn",
  effortSwitch = "next-turn",
  canPlan = true,
  runtimeModes = RuntimeMode.literals,
  onChange,
}: {
  readonly settings: ThreadSettingsPatch;
  /** Every enabled instance's models, one picker section each. */
  readonly catalog: ReadonlyArray<ConnectorModels>;
  /** The instance the thread runs on, or would; `null` when none is enabled. */
  readonly connectorInstanceId: ConnectorInstanceId | null;
  /** The thread has run something: other instances show, disabled. */
  readonly locked?: boolean;
  readonly modelSwitch?: CapabilitySwitch | "next-turn";
  readonly effortSwitch?: CapabilitySwitch | "next-turn";
  readonly canPlan?: boolean;
  /** The modes the thread's connector can honour; every mode when unknown. */
  readonly runtimeModes?: ReadonlyArray<RuntimeMode>;
  readonly onChange: (patch: ThreadSettingsPatch) => void;
}) {
  const currentModel =
    settings.model === undefined
      ? undefined
      : findModel(catalog, { connectorInstanceId, model: settings.model });
  const effortOptions: ReadonlyArray<HeaderOption> = orderEfforts(currentModel?.efforts).map(
    (effort) => ({ value: effort, label: effort }),
  );
  // A mode the connector cannot honour stays visible while it is the current
  // one — under its own name, not picked again — so the picker never lies.
  const currentMode = settings.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const runtimeModeItems: ReadonlyArray<HeaderOption> = RuntimeMode.literals
    .filter((mode) => runtimeModes.includes(mode) || mode === currentMode)
    .map((mode) =>
      runtimeModes.includes(mode)
        ? { value: mode, label: RUNTIME_MODE_LABELS[mode] }
        : {
            value: mode,
            label: RUNTIME_MODE_LABELS[mode],
            description: "Not supported by this connector",
            disabled: true,
          },
    );

  const planning = settings.interactionMode === "plan";
  const effort = settings.effort ?? "medium";
  const [modeOpen, setModeOpen] = React.useState(false);
  const [modelOpen, setModelOpen] = React.useState(false);
  const [effortOpen, setEffortOpen] = React.useState(false);

  return (
    <TooltipProvider>
      <ThreadSettingsKeys
        planOffered={canPlan || planning}
        planning={planning}
        runtimeMode={currentMode}
        runtimeModes={runtimeModes}
        effort={effort}
        efforts={currentModel?.efforts}
        effortLocked={effortSwitch === "restart"}
        onChange={onChange}
        onOpenModel={() => setModelOpen(settings.model !== undefined && modelSwitch !== "restart")}
        onOpenEffort={() => setEffortOpen(effortSwitch !== "restart")}
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <HeaderSelect
          icon={Lock}
          label="Runtime mode"
          value={currentMode}
          options={runtimeModeItems}
          capability="next-turn"
          open={modeOpen}
          onOpenChange={setModeOpen}
          onPick={(mode) => onChange({ runtimeMode: mode as RuntimeMode })}
        />
        {canPlan || planning ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={planning ? "default" : "ghost"}
                  tone={planning ? "default" : "muted"}
                  size={planning ? "default" : "icon"}
                  aria-label="Plan mode"
                  aria-pressed={planning}
                  onClick={() => onChange({ interactionMode: planning ? "default" : "plan" })}
                />
              }
            >
              <ListChecks variant="bold" data-icon={planning ? "inline-start" : undefined} />
              {planning ? "Plan" : null}
            </TooltipTrigger>
            <TooltipContent>
              {planning ? "Turn off plan mode" : "Plan before making changes"}
              <CommandKbd command="composer.planMode.toggle" />
            </TooltipContent>
          </Tooltip>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center rounded-full bg-muted">
          {settings.model ? (
            <ModelPicker
              catalog={catalog}
              instanceId={connectorInstanceId}
              model={settings.model}
              locked={locked}
              title={
                modelSwitch === "per-turn" || modelSwitch === "next-turn" ? NEXT_TURN_HINT : "Model"
              }
              disabledReason={modelSwitch === "restart" ? RESTART_TOOLTIP : undefined}
              open={modelOpen}
              onOpenChange={setModelOpen}
              onPick={(pick) => onChange(modelPickPatch(pick, locked))}
            />
          ) : null}
          <HeaderSelect
            icon={Lightning}
            label="Effort"
            value={effort}
            options={effortOptions}
            capability={effortSwitch}
            open={effortOpen}
            onOpenChange={setEffortOpen}
            onPick={(next) => onChange({ effort: next as Effort })}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
