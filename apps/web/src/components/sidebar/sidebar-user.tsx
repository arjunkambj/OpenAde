/**
 * The sidebar footer.
 *
 * It used to show a hardcoded account name and a Feedback button with no
 * handler — a fake identity and a dead control, both shipped in the packaged
 * app. OpenAde has no accounts; it runs a local server for the person at the
 * machine. So the slot reports which server this window is talking to, and
 * clicking it opens /welcome, the connection diagnostic.
 */

import { Link } from "@tanstack/react-router";

import { buttonVariants } from "@OpenAde/ui/components/button";
import { SidebarFooter } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { getResolvedConnection } from "@/state/app-runtime";
import { useConnectionState } from "@/state/hooks";

import { footerConnection } from "./sidebar-footer-state";

export function SidebarUser({ onNavigate }: { onNavigate?: () => void }) {
  const connection = useConnectionState();
  const { label, detail, dot } = footerConnection(
    connection.status,
    getResolvedConnection()?.url ?? null,
  );

  return (
    <SidebarFooter>
      <div className="flex h-9 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/welcome"
                aria-label="Connection details"
                className="mr-auto flex h-8 min-w-0 items-center gap-2 rounded-lg px-1.5 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                onClick={onNavigate}
              />
            }
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
            <span className="min-w-0 truncate type-body text-sidebar-foreground">{label}</span>
          </TooltipTrigger>
          <TooltipContent>
            {detail === null ? "No server resolved" : `Connected through ${detail}`}
          </TooltipContent>
        </Tooltip>
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
