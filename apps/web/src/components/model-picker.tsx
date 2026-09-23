/**
 * The model picker: one section per enabled connector instance, headed by the
 * instance's name and its connector's generic icon, with that instance's
 * models under it. A pick hands back the instance with the model
 * (`@/lib/model-picks`), because a thread's harness is chosen here too.
 *
 * On a thread that can no longer switch harness (`locked`) the other sections
 * stay listed but disabled, and hovering one says to start a new thread. A
 * `disabledReason` — the connector's `restart` switch — disables the whole
 * picker behind a tooltip, the way the other header pickers do.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorModels } from "@OpenAde/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";
import { connectorIconFor } from "@/lib/connector-icon";
import {
  decodeModelPick,
  encodeModelPick,
  modelPickerGroups,
  type ModelPick,
  type ModelPickerItem,
} from "@/lib/model-picks";
import { Brain } from "@honeyicons/react";

const SWITCH_CONNECTOR_TOOLTIP = "Start a new thread to switch connector";

function ModelItem({ item }: { readonly item: ModelPickerItem }) {
  return (
    <SelectItem value={item.value} disabled={item.disabled}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.label}</span>
        {item.description === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{item.description}</span>
        )}
      </span>
    </SelectItem>
  );
}

export function ModelPicker({
  catalog,
  instanceId,
  model,
  locked,
  title,
  disabledReason,
  onPick,
}: {
  readonly catalog: ReadonlyArray<ConnectorModels>;
  /** The instance the thread runs on, or would; `null` when none is enabled. */
  readonly instanceId: ConnectorInstanceId | null;
  readonly model: string;
  /** The thread has run something, so only its own instance can be picked. */
  readonly locked: boolean;
  readonly title: string;
  readonly disabledReason?: string;
  readonly onPick: (pick: ModelPick) => void;
}) {
  const { connectorDescriptorsAtom } = useClientRuntime();
  const descriptorsResult = useAtomValue(connectorDescriptorsAtom);
  const descriptors = AsyncResult.isSuccess(descriptorsResult) ? descriptorsResult.value : [];

  const groups = modelPickerGroups(catalog, { instanceId, locked });
  const value = encodeModelPick({ connectorInstanceId: instanceId, model });
  const listed = groups.flatMap((group) => group.items);
  // The current model may be absent from every list (a stale id, a catalog
  // still loading) — offer it verbatim so the picker never lies about it.
  const current = listed.some((item) => item.value === value)
    ? null
    : { value, label: model, disabled: false };
  const items = current === null ? listed : [current, ...listed];

  const select = (
    <Select
      value={value}
      disabled={disabledReason !== undefined}
      onValueChange={(next) => {
        const pick = typeof next === "string" && next !== value ? decodeModelPick(next) : null;
        if (pick !== null) {
          onPick(pick);
        }
      }}
      items={items.map((item) => ({ value: item.value, label: item.label }))}
    >
      <SelectTrigger aria-label="Model" title={title} size="sm" variant="composer">
        <span className="flex items-center gap-1.5">
          <Brain className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue className="max-w-52" />
        </span>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-56">
        {current === null ? null : (
          <SelectGroup>
            <ModelItem item={current} />
          </SelectGroup>
        )}
        {groups.map((group, index) => {
          const Icon = connectorIconFor(
            descriptors.find((entry) => entry.kind === group.connector.kind)?.metadata.iconKey,
          );
          const section = (
            <>
              <SelectLabel>
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{group.connector.displayName}</span>
                </span>
              </SelectLabel>
              {group.items.map((item) => (
                <ModelItem key={item.value} item={item} />
              ))}
            </>
          );
          return (
            <React.Fragment key={group.connector.connectorInstanceId}>
              {index > 0 || current !== null ? <SelectSeparator /> : null}
              {group.locked ? (
                <Tooltip>
                  <TooltipTrigger render={<SelectGroup />}>{section}</TooltipTrigger>
                  <TooltipContent side="right">{SWITCH_CONNECTOR_TOOLTIP}</TooltipContent>
                </Tooltip>
              ) : (
                <SelectGroup>{section}</SelectGroup>
              )}
            </React.Fragment>
          );
        })}
      </SelectContent>
    </Select>
  );

  return disabledReason === undefined ? (
    select
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{select}</TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}
