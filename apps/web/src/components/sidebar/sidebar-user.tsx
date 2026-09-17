import { Link } from "@tanstack/react-router";

import { Button, buttonVariants } from "@OpenAde/ui/components/button";
import { SidebarFooter } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

export function SidebarUser({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <SidebarFooter>
      <div className="flex h-9 items-center gap-1.5">
        <span className="ml-0.5 grid size-[26px] shrink-0 place-items-center rounded-full bg-hover text-muted-foreground">
          <Icon icon="hugeicons:user-circle" className="size-5" />
        </span>
        <span className="mr-auto truncate text-sm font-medium text-foreground">0xHoney</span>
        <Tooltip>
          <TooltipTrigger
            render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Feedback" />}
          >
            <Icon icon="hugeicons:comment-02" />
          </TooltipTrigger>
          <TooltipContent>Feedback</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/settings/$section"
                params={{ section: "general" }}
                aria-label="Settings"
                className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
                onClick={onNavigate}
              />
            }
          >
            <Icon icon="hugeicons:settings-01" />
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </SidebarFooter>
  );
}
