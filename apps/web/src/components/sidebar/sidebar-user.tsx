/**
 * The sidebar footer: the Settings button. OpenAde has no accounts, so there
 * is no identity to show here.
 */

import { Link } from "@tanstack/react-router";

import { buttonVariants } from "@OpenAde/ui/components/button";
import { SidebarFooter } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

export function SidebarUser({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <SidebarFooter padding="compact">
      <div className="flex items-center justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/settings"
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
