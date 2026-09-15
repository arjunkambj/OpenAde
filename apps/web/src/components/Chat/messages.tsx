import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function UserMessage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-label="User message"
      className={cn(
        "max-w-[min(400px,75%)] self-end rounded-xl rounded-br-md bg-hover px-4 py-2 leading-normal text-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AssistantMessage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-label="Assistant response"
      className={cn(
        "text-sm leading-prose text-foreground [&_p]:mb-3 [&_p:last-child]:mb-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
