import { useCanGoBack, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@OpenAde/ui/components/button";
import { useSidebar } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import { SearchTrigger } from "@/components/Layout/search-command";
import { CommandKbd } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, SidebarLeft } from "@honeyicons/react";

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
        <SidebarLeft variant="bold" />
        <span className="sr-only">Toggle sidebar</span>
      </TooltipTrigger>
      <TooltipContent>
        Toggle sidebar
        <CommandKbd command="sidebar.toggle" />
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="icon-sm"
                aria-label="Go back"
                disabled={!canGoBack}
                onClick={() => router.history.back()}
              />
            }
          >
            <ChevronLeft variant="bold" className="scale-90" />
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>
      </NoDrag>
      <NoDrag>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="icon-sm"
                aria-label="Go forward"
                onClick={() => router.history.forward()}
              />
            }
          >
            <ChevronRight variant="bold" className="scale-90" />
          </TooltipTrigger>
          <TooltipContent>Forward</TooltipContent>
        </Tooltip>
      </NoDrag>
    </>
  );
}

function ChromeActions({ navigationClassName }: { navigationClassName?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <NoDrag>
        <ChromeSidebarTrigger />
      </NoDrag>
      <div className={cn("ml-auto flex items-center gap-0.5", navigationClassName)}>
        <NoDrag>
          <SearchTrigger />
        </NoDrag>
        <ChromeHistoryButtons />
      </div>
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
      {/* Fullscreen with the sidebar hidden is a focus mode: only the way
          back to the sidebar stays. The desktop preload sets the attribute. */}
      <ChromeActions navigationClassName="[html[data-fullscreen]_&]:hidden" />
    </header>
  );
}

/** Settings' sidebar cannot collapse, so its chrome drops the toggle. */
export function SettingsWindowChrome() {
  return (
    <div className={cn(chromeRowClass, "hidden gap-1 pr-2 md:flex")}>
      <TrafficLightsGap />
      <div className="ml-auto flex items-center gap-0.5">
        <NoDrag>
          <SearchTrigger />
        </NoDrag>
        <ChromeHistoryButtons />
      </div>
    </div>
  );
}
