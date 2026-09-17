import { Link, useMatchRoute } from "@tanstack/react-router";

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@OpenAde/ui/components/sidebar";

import { SidebarWindowChrome } from "@/components/Layout/window-chrome";
import { ProjectTree } from "@/components/sidebar/project-tree";
import { SidebarUser } from "@/components/sidebar/sidebar-user";
import { Icon } from "@/lib/icon";

const navItems = [{ to: "/", icon: "hugeicons:add-01", label: "New task" }] as const;

export function AppSidebar() {
  const matchRoute = useMatchRoute();
  const { setOpenMobile } = useSidebar();

  function closeMobile() {
    setOpenMobile(false);
  }

  return (
    <Sidebar>
      <SidebarHeader padding="none">
        <SidebarWindowChrome />
        <div className="px-2 pt-2.5">
          <SidebarMenu>
            {navItems.map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  render={<Link to={item.to} />}
                  isActive={Boolean(matchRoute({ to: item.to, fuzzy: false }))}
                  onClick={closeMobile}
                >
                  <Icon icon={item.icon} />
                  {item.label}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </div>
      </SidebarHeader>
      <SidebarContent gap="none" className="overflow-hidden">
        <ProjectTree />
      </SidebarContent>
      <SidebarUser onNavigate={closeMobile} />
      <SidebarRail />
    </Sidebar>
  );
}
