/**
 * One `ItemSnapshot` → one row component, plus the synthetic rows: the
 * `work-group` and `turn-summary` folds and the `working` indicator.
 * `childrenByParent` threads through so task rows (and work-group bodies) can
 * render their nested items through the same dispatcher.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { memo } from "react";

import { CommandExecutionRow } from "@/components/timeline/tool-rows";
import { FileChangeRow } from "@/components/timeline/file-change-row";
import type { TimelineRow } from "@/components/timeline/fold";
import { AssistantMessageRow, UserMessageRow } from "@/components/timeline/message-rows";
import { PlanRow } from "@/components/timeline/plan-row";
import {
  ContextCompactionRow,
  ErrorRow,
  SkillRow,
  UnknownRow,
} from "@/components/timeline/status-rows";
import { TaskRow } from "@/components/timeline/task-row";
import { TodoRow } from "@/components/timeline/todo-row";
import { TurnSummaryRow } from "@/components/timeline/turn-summary-row";
import {
  McpToolCallRow,
  ReasoningRow,
  ToolCallRow,
  WebSearchRow,
} from "@/components/timeline/tool-rows";
import { WorkGroupRow } from "@/components/timeline/work-group-row";
import { Spinner } from "@honeyicons/react";

export const TimelineItemView = memo(function TimelineItemView({
  item,
  childrenByParent,
}: {
  item: ItemSnapshot;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}) {
  switch (item.kind) {
    case "user_message":
      return <UserMessageRow item={item} />;
    case "assistant_message":
      return <AssistantMessageRow item={item} />;
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "command_execution":
      return <CommandExecutionRow item={item} />;
    case "file_change":
      return <FileChangeRow item={item} />;
    case "tool_call":
      return <ToolCallRow item={item} />;
    case "mcp_tool_call":
      return <McpToolCallRow item={item} />;
    case "web_search":
      return <WebSearchRow item={item} />;
    case "task":
      return (
        <TaskRow
          item={item}
          children={childrenByParent.get(item.itemId) ?? []}
          childrenByParent={childrenByParent}
        />
      );
    case "todo":
      return <TodoRow item={item} />;
    case "skill":
      return <SkillRow item={item} />;
    case "plan":
      return <PlanRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    case "context_compaction":
      return <ContextCompactionRow item={item} />;
    case "unknown":
      return <UnknownRow item={item} />;
  }
});

/** The trailing indicator while a turn is open. */
function WorkingRow() {
  return (
    <div className="flex min-h-6 items-center gap-2 py-0.5 type-body text-muted-foreground">
      <Spinner className="size-3.5" />
      Working…
    </div>
  );
}

/** Row dispatch for the virtualized list: item rows vs fold summaries. */
export function TimelineRowView({
  row,
  childrenByParent,
}: {
  row: TimelineRow;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}) {
  if (row.kind === "item") {
    return <TimelineItemView item={row.item} childrenByParent={childrenByParent} />;
  }
  if (row.kind === "work-group") {
    return <WorkGroupRow group={row} childrenByParent={childrenByParent} />;
  }
  if (row.kind === "turn-summary") {
    return <TurnSummaryRow summary={row} />;
  }
  return <WorkingRow />;
}
