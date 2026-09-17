/**
 * The settings window's shell.
 *
 * `SearchProvider` is mounted here as well as in `HomeLayout` because it is
 * what claims the thread-independent half of the keybinding table — the
 * palette, the sidebar toggle, new thread, skills, settings. Without it those
 * chords did nothing at all while a settings page was open, so Cmd+K on
 * /settings/connectors was a dead key.
 */

import { Outlet } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";
import { TooltipProvider } from "@OpenAde/ui/components/tooltip";

import { SearchProvider } from "@/components/Layout/search-command";
import { SettingsSidebar } from "@/components/Layout/settings-sidebar";

export function SettingsLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <TooltipProvider delay={300}>
        <SearchProvider>
          <SettingsSidebar />
          <SidebarInset>
            <Outlet />
          </SidebarInset>
        </SearchProvider>
      </TooltipProvider>
    </SidebarProvider>
  );
}
