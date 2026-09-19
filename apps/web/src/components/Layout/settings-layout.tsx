/**
 * The settings window's shell.
 *
 * No `SearchProvider` here on purpose. The route-independent half of the
 * keybinding table — the palette, new thread, skills, settings — is claimed
 * once above the routes (routes/__root.tsx), which already covers
 * `/settings/*`. A second provider inside this layout claimed the same four
 * ids from a later commit and took them with it on unmount, so one visit to
 * Settings left those chords dead everywhere until the window was reloaded.
 *
 * `sidebar.toggle` is deliberately unclaimed here: these pages have a
 * `collapsible="none"` sidebar, so the chord is better left unanswered than
 * bound to a no-op.
 *
 * The sidebar takes the width the main sidebar was dragged to, so moving
 * between the two never makes the edge jump.
 */

import { Outlet } from "@tanstack/react-router";
import type * as React from "react";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";
import { TooltipProvider } from "@OpenAde/ui/components/tooltip";

import { SettingsSidebar } from "@/components/Layout/settings-sidebar";
import { useSidebarWidth } from "@/state/ui";

export function SettingsLayout() {
  const [sidebarWidth] = useSidebarWidth();
  return (
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <TooltipProvider delay={300}>
        <SettingsSidebar />
        <SidebarInset>
          <Outlet />
        </SidebarInset>
      </TooltipProvider>
    </SidebarProvider>
  );
}
