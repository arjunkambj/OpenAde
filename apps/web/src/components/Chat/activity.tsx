import type { ComponentProps, ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@OpenAde/ui/components/collapsible";

import { FileTag } from "@/components/Chat/file-tag";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

export function Activity({ children, className }: ComponentProps<"div">) {
  return (
    <div data-slot="activity" className={cn("flex flex-col gap-1", className)}>
      {children}
    </div>
  );
}

export function ActivityItem({
  icon,
  label,
  stats,
  files,
  defaultOpen = false,
  children,
}: {
  icon: string;
  label: ReactNode;
  stats?: string;
  files?: string[];
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/activity">
      <CollapsibleTrigger variant="summary">
        <span className="relative size-3.5 shrink-0">
          <Icon
            icon="hugeicons:arrow-right-01"
            className="absolute inset-0 size-3.5 opacity-0 transition-reveal duration-150 ease-out group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100 group-data-open/activity:rotate-90"
          />
          <Icon
            icon={icon}
            className="size-3.5 transition-opacity duration-150 ease-out group-hover/summary:opacity-0 group-focus-visible/summary:opacity-0"
          />
        </span>
        <span className="min-w-0">{label}</span>
        {files?.map((file) => (
          <FileTag key={file} tone="file">
            {file}
          </FileTag>
        ))}
        {stats ? <span className="ml-1 type-micro text-muted-foreground">{stats}</span> : null}
      </CollapsibleTrigger>
      {children ? (
        <CollapsibleContent keepMounted variant="indented" className="ml-1.5">
          {children}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
