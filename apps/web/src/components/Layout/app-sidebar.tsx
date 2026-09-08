import { Link, useMatchRoute } from "@tanstack/react-router";

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
  const matchRoute = useMatchRoute();
  const { setOpenMobile } = useSidebar();

  const isNewChat = Boolean(matchRoute({ to: "/", fuzzy: false }));
  const isSkills = Boolean(matchRoute({ to: "/skills", fuzzy: false }));

  function closeMobile() {
    setOpenMobile(false);
  }

  return (
    <Sidebar>
      <SidebarHeader className="gap-0 p-0">
        <SidebarWindowChrome />
        <SidebarMenu className="px-2 pt-1 pb-2">
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" />} isActive={isNewChat} onClick={closeMobile}>
              <Icon icon="hugeicons:add-01" />
              New chat
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/skills" />}
              isActive={isSkills}
              onClick={closeMobile}
            >
              <Icon icon="hugeicons:layers-01" />
              Skills
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
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/settings/uses" />} onClick={closeMobile}>
              <Icon icon="hugeicons:flash" />
              Uses
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/settings" />} onClick={closeMobile}>
              <Icon icon="hugeicons:settings-01" />
              Settings
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
