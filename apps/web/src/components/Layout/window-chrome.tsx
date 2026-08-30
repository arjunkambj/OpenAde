import { Button } from "@OpenAde/ui/components/button";
import { useSidebar } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { SearchTrigger } from "@/components/Layout/search-command";
import { Icon } from "@/lib/icon";
import { ShortcutKbd } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const chromeRowClass =
  "app-region-drag electrobun-webkit-app-region-drag flex h-11 shrink-0 items-center";

const noDragClass = "app-region-no-drag electrobun-webkit-app-region-no-drag";

function TrafficLightsGap({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("h-full w-[var(--traffic-lights-width,0px)] shrink-0", className)}
    />
  );
}

function ChromeSidebarTrigger({ className }: { className?: string }) {
  const { toggleSidebar } = useSidebar();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-sidebar="trigger"
            data-slot="sidebar-trigger"
            variant="ghost"
            size="icon-sm"
            className={className}
            onClick={() => toggleSidebar()}
          />
        }
      >
        <Icon icon="solar:sidebar-minimalistic-linear" className="rotate-180" />
        <span className="sr-only">Toggle sidebar</span>
      </TooltipTrigger>
      <TooltipContent>
        Toggle sidebar
        <ShortcutKbd id="toggle" />
      </TooltipContent>
    </Tooltip>
  );
}

function ChromeActions({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <SearchTrigger className={noDragClass} />
      <ChromeSidebarTrigger className={noDragClass} />
    </div>
  );
}

export function SidebarWindowChrome() {
  return (
    <div className={cn(chromeRowClass, "hidden pr-2 md:flex")}>
      <TrafficLightsGap />
      <ChromeActions className="ml-auto" />
    </div>
  );
}

export function InsetWindowChrome() {
  const { state, isMobile } = useSidebar();

  if (!isMobile && state === "expanded") {
    return null;
  }

  return (
    <header className={cn(chromeRowClass, "gap-1.5 pr-2", isMobile && "px-2")}>
      <TrafficLightsGap />
      <ChromeActions />
    </header>
  );
}

export function SettingsWindowChrome() {
  return <div className={cn(chromeRowClass, "hidden md:flex")} />;
}
