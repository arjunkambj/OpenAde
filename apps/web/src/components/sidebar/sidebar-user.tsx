/**
 * The sidebar footer: the Settings button. Poseidon has no accounts, so there
 * is no identity to show here.
 */

import { Link } from "@tanstack/react-router";

import { buttonVariants } from "@poseidon/ui/components/button";
import { SidebarFooter } from "@poseidon/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { cn } from "@/lib/utils";
import { Settings as SettingsIcon } from "@honeyicons/react";

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
            <SettingsIcon variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </SidebarFooter>
  );
}
