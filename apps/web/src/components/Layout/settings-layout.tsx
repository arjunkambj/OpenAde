import { Outlet } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@OpenAde/ui/components/sidebar";

import { SettingsSidebar } from "@/components/Layout/settings-sidebar";

export function SettingsLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <SettingsSidebar />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
