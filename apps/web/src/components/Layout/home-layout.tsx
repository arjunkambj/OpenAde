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
