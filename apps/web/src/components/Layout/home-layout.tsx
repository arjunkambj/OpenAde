/**
 * The main window's shell: sidebar, window chrome, connection banner, route
 * outlet — and the one place the thread-independent half of the server-owned
 * keybinding table is bound. Thread-scoped bindings (`thread.interrupt`,
 * `composer.queue`, `browserPane.toggle`) belong to the thread view, which is
 * the only component that knows which thread they act on.
 */

import { Outlet, useNavigate } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";
import { TooltipProvider } from "@OpenAde/ui/components/tooltip";

import { ConnectionBanner } from "@/components/Layout/connection-banner";
import { SearchProvider, useSearch } from "@/components/Layout/search-command";
import { InsetWindowChrome } from "@/components/Layout/window-chrome";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { useGlobalKeybindings } from "@/lib/use-keybindings";

function HomeKeybindings() {
  const { setOpen, toggle } = useSearch();
  const navigate = useNavigate();

  useGlobalKeybindings({
    "commandPalette.toggle": toggle,
    // The palette is a modal dialog over the route, so navigating without
    // closing it leaves the user on the start screen behind an overlay.
    "thread.new": () => {
      setOpen(false);
      void navigate({ to: "/" });
    },
  });

  return null;
}

export function HomeLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <TooltipProvider delay={300}>
        <SearchProvider>
          <HomeKeybindings />
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
