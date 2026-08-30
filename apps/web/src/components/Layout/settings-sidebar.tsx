import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";

import { Icon } from "@/lib/icon";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@OpenAde/ui/components/sidebar";

import { SettingsWindowChrome } from "@/components/Layout/window-chrome";

export function SettingsSidebar() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const isGeneral = Boolean(matchRoute({ to: "/settings", fuzzy: false }));
  const isUses = Boolean(matchRoute({ to: "/settings/uses", fuzzy: false }));

  return (
    <Sidebar collapsible="none" className="h-svh border-r">
      <SidebarHeader className="gap-0 p-0">
        <SettingsWindowChrome />
        <SidebarMenu className="px-2 pt-1 pb-2">
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                void navigate({ to: "/" });
              }}
            >
              <Icon icon="solar:alt-arrow-left-linear" />
              Back to chat
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/settings" />} isActive={isGeneral}>
                  <Icon icon="solar:tuning-2-linear" />
                  General
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/settings/uses" />} isActive={isUses}>
                  <Icon icon="solar:bolt-linear" />
                  Uses
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
