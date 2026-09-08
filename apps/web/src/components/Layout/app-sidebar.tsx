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

import { SidebarProjects } from "@/components/Layout/sidebar-projects";
import { SidebarUser } from "@/components/Layout/sidebar-user";
import { SidebarWindowChrome } from "@/components/Layout/window-chrome";
import { Icon } from "@/lib/icon";

const navItems = [
  { to: "/", icon: "hugeicons:add-01", label: "New task" },
  { to: "/review", icon: "hugeicons:git-compare", label: "Review work" },
  { to: "/skills", icon: "hugeicons:dashboard-circle-add", label: "Skill & Plugins" },
] as const;

export function AppSidebar() {
  const matchRoute = useMatchRoute();
  const { setOpenMobile } = useSidebar();

  function closeMobile() {
    setOpenMobile(false);
  }

  return (
    <Sidebar>
      <SidebarHeader className="gap-0 p-0">
        <SidebarWindowChrome />
        <SidebarMenu className="px-2 pt-2.5">
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
      </SidebarHeader>
      <SidebarContent className="gap-0 overflow-hidden">
        <SidebarProjects />
      </SidebarContent>
      <SidebarUser onNavigate={closeMobile} />
      <SidebarRail />
    </Sidebar>
  );
}
