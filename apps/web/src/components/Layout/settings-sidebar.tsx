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
    <Sidebar collapsible="none" variant="bordered" className="h-svh">
      <SidebarHeader padding="none">
        <SettingsWindowChrome />
        <div className="px-2 pt-1 pb-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  void navigate({ to: "/" });
                }}
              >
                <Icon icon="hugeicons:arrow-left-01" />
                Back to chat
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/settings" />} isActive={isGeneral}>
                  <Icon icon="hugeicons:sliders-horizontal" />
                  General
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/settings/uses" />} isActive={isUses}>
                  <Icon icon="hugeicons:flash" />
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
