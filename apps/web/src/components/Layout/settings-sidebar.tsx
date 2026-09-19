import { Link, useMatchRoute } from "@tanstack/react-router";

import { Icon } from "@/lib/icon";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@OpenAde/ui/components/sidebar";

import { SettingsWindowChrome } from "@/components/Layout/window-chrome";
import { SidebarPrimaryNav } from "@/components/sidebar/sidebar-primary-nav";

const ITEMS = [
  { to: "/settings", label: "General", icon: "hugeicons:sliders-horizontal" },
  { to: "/settings/models", label: "Models", icon: "hugeicons:ai-chat-02" },
  { to: "/settings/connectors", label: "Connectors", icon: "hugeicons:plug-01" },
  { to: "/settings/keybindings", label: "Keybindings", icon: "hugeicons:keyboard" },
] as const;

export function SettingsSidebar() {
  const matchRoute = useMatchRoute();

  return (
    <Sidebar collapsible="none" variant="bordered" className="h-svh">
      <SidebarHeader padding="none">
        <SettingsWindowChrome />
        <SidebarPrimaryNav />
      </SidebarHeader>
      <SidebarContent gap="none">
        <SidebarGroup padding="section">
          <SidebarGroupLabel className="h-8">Settings</SidebarGroupLabel>
          <SidebarGroupContent className="mt-1">
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
