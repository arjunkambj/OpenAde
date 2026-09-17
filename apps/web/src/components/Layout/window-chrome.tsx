import { useCanGoBack, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@OpenAde/ui/components/button";
import { useSidebar } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { SearchTrigger } from "@/components/Layout/search-command";
import { Icon } from "@/lib/icon";
import { ShortcutKbd } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const chromeRowClass = "app-region-drag flex h-[var(--chrome-height)] shrink-0 items-center";

function NoDrag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("app-region-no-drag inline-flex", className)}>{children}</span>;
}

function TrafficLightsGap({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("h-full w-[var(--traffic-lights-width,0px)] shrink-0", className)}
    />
  );
}

function ChromeSidebarTrigger() {
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
            onClick={() => toggleSidebar()}
          />
        }
      >
        <Icon icon="hugeicons:layout-left" />
        <span className="sr-only">Toggle sidebar</span>
      </TooltipTrigger>
      <TooltipContent>
        Toggle sidebar
        <ShortcutKbd id="toggle" />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Back and forward over the router's own history. These used to be rendered
 * permanently `disabled` — two greyed-out controls in the window chrome of
 * every build that could never do anything. Back knows whether there is
 * anywhere to go; forward cannot be asked, so it stays live and no-ops at the
 * end of the stack, the way a browser's does.
 */
function ChromeHistoryButtons() {
  const router = useRouter();
  const canGoBack = useCanGoBack();

  return (
    <>
      <NoDrag>
        <Button
          type="button"
          variant="ghost"
          tone="subtle"
          size="icon-sm"
          aria-label="Go back"
          disabled={!canGoBack}
          onClick={() => router.history.back()}
        >
          <Icon icon="hugeicons:arrow-left-01" className="scale-90" />
        </Button>
      </NoDrag>
      <NoDrag>
        <Button
          type="button"
          variant="ghost"
          tone="subtle"
          size="icon-sm"
          aria-label="Go forward"
          onClick={() => router.history.forward()}
        >
          <Icon icon="hugeicons:arrow-right-01" className="scale-90" />
        </Button>
      </NoDrag>
    </>
  );
}

function ChromeActions({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-0.5", className)}>
      <NoDrag>
        <ChromeSidebarTrigger />
      </NoDrag>
      <NoDrag className="ml-auto">
        <SearchTrigger />
      </NoDrag>
      <ChromeHistoryButtons />
    </div>
  );
}

export function SidebarWindowChrome() {
  return (
    <div className={cn(chromeRowClass, "hidden gap-1 pr-2 md:flex")}>
      <TrafficLightsGap />
      <ChromeActions />
    </div>
  );
}

export function InsetWindowChrome() {
  const { state, isMobile } = useSidebar();

  if (!isMobile && state === "expanded") {
    return null;
  }

  return (
    <header className={cn(chromeRowClass, "gap-1 pr-2", isMobile && "px-2")}>
      <TrafficLightsGap />
      <ChromeActions />
    </header>
  );
}

export function SettingsWindowChrome() {
  return <div className={cn(chromeRowClass, "hidden md:flex")} />;
}
