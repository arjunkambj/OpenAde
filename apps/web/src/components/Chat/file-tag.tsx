import type { ReactNode } from "react";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

export function FileTag({
  children,
  icon = false,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  icon?: boolean;
  tone?: "muted" | "file";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1 align-baseline font-mono text-xs leading-normal",
        tone === "file" ? "bg-file-bg text-file" : "bg-hover text-sidebar-foreground",
        className,
      )}
    >
      {icon ? <Icon icon="hugeicons:file-01" className="size-3.5" /> : null}
      {children}
    </span>
  );
}
