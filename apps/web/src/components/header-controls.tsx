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
 * model *list* does not wait for that binding: it comes from the instance the
 * thread would route to (`@/lib/connector-routing`), and so do the runtime
 * modes on offer (`@/lib/runtime-modes`). Efforts read lowest first in the
 * contract's order (`@/lib/efforts`).
 */

import { Button } from "@OpenAde/ui/components/button";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@OpenAde/ui/components/tooltip";
import { DEFAULT_RUNTIME_MODE, type Effort, RuntimeMode } from "@OpenAde/contracts/enums";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";
import type { ModelOption } from "@OpenAde/contracts/rpc";
import type { CapabilitySwitch } from "@OpenAde/contracts/runtime";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import { routedCapabilities, routedConnectorInstanceId } from "@/lib/connector-routing";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { orderEfforts } from "@/lib/efforts";
import { RUNTIME_MODE_LABELS, runtimeModeOptions } from "@/lib/runtime-modes";
import { type HoneyIcon, Brain, Lightning, ListChecks, Lock } from "@honeyicons/react";

interface HeaderOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

const RESTART_TOOLTIP = "Applies only on session restart — the running session keeps its settings";
const NEXT_TURN_HINT = "applies next turn";

/**
 * One labelled picker. `capability` is the connector's switch behaviour for
 * this knob; absent means the setting is a server-side mode read at turn
 * start, which is exactly the per-turn contract — so the hint stays.
 */
function HeaderSelect({
  icon: Glyph,
  label,
  value,
  options,
  capability,
  onPick,
}: {
  readonly icon: HoneyIcon;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<HeaderOption>;
  readonly capability: CapabilitySwitch | "next-turn";
  readonly onPick: (value: string) => void;
}) {
  const restartLocked = capability === "restart";
  const nextTurn = capability === "per-turn" || capability === "next-turn";
  // The current value may be absent from the option list (a stale model id) —
  // offer it verbatim so the picker never lies about the setting.
  const items = options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options];

  const select = (
    <Select
      value={value}
      disabled={restartLocked}
      onValueChange={(next) => {
        if (typeof next === "string" && next.length > 0 && next !== value) {
          onPick(next);
        }
      }}
      items={items.map((item) => ({ value: item.value, label: item.label }))}
    >
      <SelectTrigger
        aria-label={label}
        title={nextTurn ? NEXT_TURN_HINT : label}
        size="sm"
        variant="composer"
      >
        <span className="flex items-center gap-1.5">
          <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue className="max-w-52" />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-44">
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.label}</span>
                {item.description === undefined ? null : (
                  <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {restartLocked ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{select}</TooltipTrigger>
          <TooltipContent>{RESTART_TOOLTIP}</TooltipContent>
        </Tooltip>
      ) : (
        select
      )}
    </span>
  );
}

export function HeaderControls({
  threadId,
  className,
}: {
  readonly threadId: ThreadId;
  readonly className?: string;
}) {
  const { threadDetailAtom, connectorsAtom, connectorModelsAtom, dispatchAtom } =
    useClientRuntime();
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
  // The model list, though, is the instance this thread *would* run on — see
  // `@/lib/connector-routing`. Without it a thread that has not run a turn yet
  // offered a picker holding nothing but the raw current model id.
  const modelsResult = useAtomValue(
    connectorModelsAtom(routedConnectorInstanceId(boundInstanceId, connectors)),
  );
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];
  // What the harness can honour is known before any session is bound.
  const runtimeModes = runtimeModeOptions(routedCapabilities(boundInstanceId, connectors));

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
        models={models}
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
  models,
  modelSwitch = "next-turn",
  effortSwitch = "next-turn",
  canPlan = true,
  runtimeModes = RuntimeMode.literals,
  onChange,
}: {
  readonly settings: ThreadSettingsPatch;
  readonly models: ReadonlyArray<ModelOption>;
  readonly modelSwitch?: CapabilitySwitch | "next-turn";
  readonly effortSwitch?: CapabilitySwitch | "next-turn";
  readonly canPlan?: boolean;
  /** The modes the thread's connector can honour; every mode when unknown. */
  readonly runtimeModes?: ReadonlyArray<RuntimeMode>;
  readonly onChange: (patch: ThreadSettingsPatch) => void;
}) {
  const modelOptions: ReadonlyArray<HeaderOption> = models.map((model) => ({
    value: model.id,
    label: model.label,
    description: model.family === "" ? undefined : model.family,
  }));

  const currentModel = models.find((model) => model.id === settings.model);
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

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <HeaderSelect
          icon={Lock}
          label="Runtime mode"
          value={currentMode}
          options={runtimeModeItems}
          capability="next-turn"
          onPick={(mode) => onChange({ runtimeMode: mode as RuntimeMode })}
        />
        {canPlan || planning ? (
          <Button
            type="button"
            variant={planning ? "default" : "ghost"}
            tone={planning ? "default" : "muted"}
            size={planning ? "default" : "icon"}
            aria-label="Plan mode"
            aria-pressed={planning}
            title={planning ? "Turn off plan mode" : "Plan before making changes"}
            onClick={() => onChange({ interactionMode: planning ? "default" : "plan" })}
          >
            <ListChecks data-icon={planning ? "inline-start" : undefined} />
            {planning ? "Plan" : null}
          </Button>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center rounded-full bg-muted">
          {settings.model ? (
            <HeaderSelect
              icon={Brain}
              label="Model"
              value={settings.model}
              options={modelOptions}
              capability={modelSwitch}
              onPick={(model) => onChange({ model })}
            />
          ) : null}
          <HeaderSelect
            icon={Lightning}
            label="Effort"
            value={settings.effort ?? "medium"}
            options={effortOptions}
            capability={effortSwitch}
            onPick={(effort) => onChange({ effort: effort as Effort })}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
