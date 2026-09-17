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

const sections = [
  { section: "general", icon: "hugeicons:sliders-horizontal", label: "General" },
  { section: "uses", icon: "hugeicons:flash", label: "Uses" },
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
              {sections.map((item) => (
                <SidebarMenuItem key={item.section}>
                  <SidebarMenuButton
                    render={<Link to="/settings/$section" params={{ section: item.section }} />}
                    isActive={Boolean(
                      matchRoute({
                        to: "/settings/$section",
                        params: { section: item.section },
                      }),
                    )}
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
