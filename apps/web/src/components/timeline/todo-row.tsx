/**
 * `todo` — the model's checklist, rendered as a small checklist block rather
 * than a disclosure so the current step is always visible.
 */

import type { ItemSnapshot, Todo } from "@OpenAde/contracts/runtime";

import { cn } from "@/lib/utils";
import { Check, Close } from "@honeyicons/react";

function TodoIcon({ status }: { status: Todo["status"] }) {
  if (status === "completed") {
    return <Check className="size-3.5 text-added" />;
  }
  if (status === "in_progress") {
    return <Close className="size-3.5 text-permission" />;
  }
  return <Close className="size-3.5 text-muted-foreground" />;
}

export function TodoRow({ item }: { item: ItemSnapshot }) {
  const todos = item.todos ?? [];
  return (
    <div className="flex flex-col gap-1 py-0.5 type-body leading-compact">
      {todos.map((todo) => (
        <div key={todo.todoId} className="flex min-h-5 items-center gap-2">
          <TodoIcon status={todo.status} />
          <span
            className={cn(
              "min-w-0 truncate",
              todo.status === "completed" && "text-muted-foreground line-through",
              todo.status === "pending" && "text-muted-foreground",
            )}
          >
            {todo.text}
          </span>
        </div>
      ))}
    </div>
  );
}
