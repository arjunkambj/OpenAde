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

const ITEMS = [
  { to: "/settings", label: "General", icon: "hugeicons:sliders-horizontal" },
  { to: "/settings/connectors", label: "Connectors", icon: "hugeicons:plug-01" },
  { to: "/settings/mcp", label: "MCP servers", icon: "hugeicons:server-stack-01" },
  { to: "/settings/skills", label: "Skills", icon: "hugeicons:magic-wand-01" },
  { to: "/settings/keybindings", label: "Keybindings", icon: "hugeicons:keyboard" },
  { to: "/settings/appearance", label: "Appearance", icon: "hugeicons:colors" },
] as const;

export function SettingsSidebar() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();

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
              {ITEMS.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    render={<Link to={item.to} />}
                    isActive={Boolean(matchRoute({ to: item.to, fuzzy: false }))}
                  >
                    <Icon icon={item.icon} />
                    {item.label}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
