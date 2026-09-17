/**
 * The files pane's one empty/loading/error block. Every state the pane can be
 * in renders through this, so "nothing here" always looks deliberate.
 */

import type { ReactNode } from "react";

import { Icon } from "@/lib/icon";

export function PaneMessage({
  icon,
  text,
  detail,
  action,
}: {
  readonly icon: string;
  readonly text: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon icon={icon} className="size-6 text-muted-foreground" />
      <p className="type-body text-muted-foreground">{text}</p>
      {detail === undefined ? null : (
        <p className="max-w-full truncate type-micro text-muted-foreground">{detail}</p>
      )}
      {action}
    </div>
  );
}
