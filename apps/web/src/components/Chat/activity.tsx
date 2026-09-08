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
      <CollapsibleTrigger
        className={cn(
          "group/summary relative flex min-h-6 w-full cursor-pointer items-center gap-2 rounded-sm bg-transparent py-0.5 text-left text-[13px] leading-[1.55] font-normal text-muted-foreground outline-none transition-colors duration-150 ease-out",
          "hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="relative size-3.5 shrink-0">
          <Icon
            icon="hugeicons:arrow-right-01"
            className="absolute inset-0 size-3.5 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100 group-data-open/activity:rotate-90"
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
        {stats ? <span className="ml-1 text-[11px] text-muted-foreground">{stats}</span> : null}
      </CollapsibleTrigger>
      {children ? (
        <CollapsibleContent
          keepMounted
          className="overflow-hidden border-l border-border py-2 pr-0 pl-3.5 ml-1.5 text-[13px] leading-relaxed text-muted-foreground transition-[opacity,translate] duration-150 ease-out data-closed:py-0 data-closed:opacity-0 data-closed:translate-y-[-2px]"
        >
          {children}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
