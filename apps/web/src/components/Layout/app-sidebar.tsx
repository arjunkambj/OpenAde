import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";

import { Icon } from "@/lib/icon";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@OpenAde/ui/components/sidebar";

import { SidebarWindowChrome } from "@/components/Layout/window-chrome";

export function AppSidebar() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { setOpenMobile } = useSidebar();

  const isSkill = Boolean(matchRoute({ to: "/skill", fuzzy: false }));

  function closeMobile() {
    setOpenMobile(false);
  }

  return (
    <Sidebar>
      <SidebarHeader className="gap-0 p-0">
        <SidebarWindowChrome />
        <SidebarMenu className="px-2 pt-1 pb-2">
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                closeMobile();
                void navigate({ to: "/" });
              }}
            >
              <Icon icon="solar:add-linear" />
              New chat
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/skill" />}
              isActive={isSkill}
              onClick={closeMobile}
            >
              <Icon icon="solar:magic-stick-3-linear" />
              Skill
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Project</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Chat</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/settings/uses" />}
              onClick={closeMobile}
            >
              <Icon icon="solar:chart-linear" />
              Uses
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/settings" />}
              onClick={closeMobile}
            >
              <Icon icon="solar:settings-linear" />
              Settings
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
