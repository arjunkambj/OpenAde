import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from "@poseidon/ui/components/sidebar";

import { SidebarWindowChrome } from "@/components/Layout/window-chrome";
import { ProjectTree } from "@/components/sidebar/project-tree";
import { SidebarPrimaryNav } from "@/components/sidebar/sidebar-primary-nav";
import { SidebarResizeHandle } from "@/components/sidebar/sidebar-resize-handle";
import { SidebarUser } from "@/components/sidebar/sidebar-user";

export function AppSidebar() {
  const { setOpenMobile } = useSidebar();

  function closeMobile() {
    setOpenMobile(false);
  }

  return (
    <Sidebar>
      <SidebarHeader padding="none">
        <SidebarWindowChrome />
        <SidebarPrimaryNav onNavigate={closeMobile} />
      </SidebarHeader>
      <SidebarContent gap="none" className="overflow-hidden">
        <ProjectTree />
      </SidebarContent>
      <SidebarUser onNavigate={closeMobile} />
      <SidebarResizeHandle />
    </Sidebar>
  );
}
