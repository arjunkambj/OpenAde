/**
 * The thread header controls: model, effort, runtime mode and interaction
 * mode pickers. Every pick is a `thread.settings.update` dispatch — the doc
 * updates when `thread.settings.updated` lands, and a rejected or unreachable
 * dispatch says so beside the pickers instead of letting the value snap back
 * with no explanation.
 *
 * Capability wiring (spec section 11): a `restart` switch disables the picker
 * with a tooltip; `per-turn` adds an "applies next turn" hint; plan mode
 * disappears from the interaction picker when the connector cannot plan. A
 * thread with no bound session reports no capabilities, in which case model
 * and effort behave as per-turn — that is what a fresh session consumes. The
 * model *list* does not wait for that binding: it comes from the instance the
 * thread would route to (`@/lib/connector-routing`).
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@OpenAde/ui/components/tooltip";
import { cn } from "@OpenAde/ui/lib/utils";
import type { Effort, InteractionMode, RuntimeMode } from "@OpenAde/contracts/enums";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSettingsPatch } from "@OpenAde/contracts/orchestration";
import type { CapabilitySwitch } from "@OpenAde/contracts/runtime";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import { routedConnectorInstanceId } from "@/lib/connector-routing";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { Icon } from "@/lib/icon";

interface HeaderOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

const ALL_EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"];

const RUNTIME_MODE_OPTIONS: ReadonlyArray<HeaderOption> = [
  { value: "approval-required", label: "Ask first" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "full-access", label: "Full access" },
];

const INTERACTION_OPTIONS: ReadonlyArray<HeaderOption> = [
  { value: "default", label: "Execute" },
  { value: "plan", label: "Plan first" },
];

const RESTART_TOOLTIP = "Applies only on session restart — the running session keeps its settings";
const NEXT_TURN_HINT = "applies next turn";

/**
 * One labelled picker. `capability` is the connector's switch behaviour for
 * this knob; absent means the setting is a server-side mode read at turn
 * start, which is exactly the per-turn contract — so the hint stays.
 */
function HeaderSelect({
  icon,
  label,
  value,
  options,
  capability,
  onPick,
}: {
  readonly icon: string;
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
      <SelectTrigger aria-label={label} size="sm" variant="ghost">
        <span className="flex items-center gap-1.5">
          <Icon icon={icon} className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-44">
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
      {nextTurn ? (
        <span className="shrink-0 text-xs text-muted-foreground/70">{NEXT_TURN_HINT}</span>
      ) : null}
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

  const modelOptions: ReadonlyArray<HeaderOption> = models.map((model) => ({
    value: model.id,
    label: model.label,
    description: model.family === "" ? undefined : model.family,
  }));

  const currentModel = models.find((model) => model.id === doc.settings.model);
  const effortOptions: ReadonlyArray<HeaderOption> = (currentModel?.efforts ?? ALL_EFFORTS).map(
    (effort) => ({ value: effort, label: effort }),
  );

  const interactionOptions: ReadonlyArray<HeaderOption> = INTERACTION_OPTIONS.map((option) =>
    option.value === "plan" && capabilities !== null && !capabilities.planMode
      ? { ...option, disabled: true }
      : option,
  );

  return (
    <TooltipProvider>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
        <HeaderSelect
          icon="hugeicons:ai-chat-02"
          label="Model"
          value={doc.settings.model}
          options={modelOptions}
          capability={capabilities?.modelSwitch ?? "per-turn"}
          onPick={(model) => update({ model })}
        />
        <HeaderSelect
          icon="hugeicons:zap"
          label="Effort"
          value={doc.settings.effort ?? "medium"}
          options={effortOptions}
          capability={capabilities?.effortSwitch ?? "per-turn"}
          onPick={(effort) => update({ effort: effort as Effort })}
        />
        <HeaderSelect
          icon="hugeicons:shield-01"
          label="Runtime mode"
          value={doc.settings.runtimeMode}
          options={RUNTIME_MODE_OPTIONS}
          capability="next-turn"
          onPick={(mode) => update({ runtimeMode: mode as RuntimeMode })}
        />
        <HeaderSelect
          icon="hugeicons:check-list"
          label="Interaction mode"
          value={doc.settings.interactionMode}
          options={interactionOptions}
          capability="next-turn"
          onPick={(mode) => update({ interactionMode: mode as InteractionMode })}
        />
        {error === null ? null : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}
