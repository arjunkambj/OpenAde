import { Outlet } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";
import { TooltipProvider } from "@OpenAde/ui/components/tooltip";

import { AppSidebar } from "@/components/Layout/app-sidebar";
import { SearchProvider } from "@/components/Layout/search-command";
import { InsetWindowChrome } from "@/components/Layout/window-chrome";

export function HomeLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <TooltipProvider delay={300}>
        <SearchProvider>
          <AppSidebar />
          <SidebarInset>
            <InsetWindowChrome />
            <Outlet />
          </SidebarInset>
        </SearchProvider>
      </TooltipProvider>
    </SidebarProvider>
  );
}
