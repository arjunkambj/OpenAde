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
 */

import { Outlet } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";
import { TooltipProvider } from "@OpenAde/ui/components/tooltip";

import { SettingsSidebar } from "@/components/Layout/settings-sidebar";

export function SettingsLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <TooltipProvider delay={300}>
        <SettingsSidebar />
        <SidebarInset>
          <Outlet />
        </SidebarInset>
      </TooltipProvider>
    </SidebarProvider>
  );
}
