/**
 * The main window's shell: sidebar, window chrome, connection banner, route
 * outlet. The thread-independent half of the server-owned keybinding table is
 * claimed by `SearchProvider`, which owns the surfaces those commands act on;
 * thread-scoped bindings (`thread.interrupt`, `composer.queue`,
 * `browserPane.toggle`) belong to the thread view, which is the only component
 * that knows which thread they act on. Neither listens for keys itself — the
 * one listener lives in `KeybindingsProvider` above the routes.
 */

import { Outlet } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";
import { TooltipProvider } from "@OpenAde/ui/components/tooltip";

import { ConnectionBanner } from "@/components/Layout/connection-banner";
import { SearchProvider } from "@/components/Layout/search-command";
import { InsetWindowChrome } from "@/components/Layout/window-chrome";
import { AppSidebar } from "@/components/sidebar/app-sidebar";

export function HomeLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <TooltipProvider delay={300}>
        <SearchProvider>
          <AppSidebar />
          <SidebarInset className="min-h-0 overflow-hidden">
            <InsetWindowChrome />
            <ConnectionBanner />
            <Outlet />
          </SidebarInset>
        </SearchProvider>
      </TooltipProvider>
    </SidebarProvider>
  );
}
