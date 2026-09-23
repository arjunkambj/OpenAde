import { Link, useMatchRoute } from "@tanstack/react-router";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@OpenAde/ui/components/sidebar";

import { SquarePen, Widget } from "@honeyicons/react";

const navItems = [
  { to: "/", icon: SquarePen, label: "New task", fuzzy: false },
  { to: "/customize", icon: Widget, label: "Customize", fuzzy: true },
] as const;

/**
 * The top of every sidebar. The app and settings sidebars both render it so
 * the top stays put when moving between them; only what sits below changes.
 * It owns its own padding so the two can never drift apart.
 */
export function SidebarPrimaryNav({ onNavigate }: { onNavigate?: () => void }) {
  const matchRoute = useMatchRoute();

  return (
    <div className="px-2 pt-1">
      <SidebarMenu>
        {navItems.map((item) => (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton
              render={<Link to={item.to} />}
              isActive={Boolean(matchRoute({ to: item.to, fuzzy: item.fuzzy }))}
              onClick={onNavigate}
            >
              <item.icon variant="bold" />
              {item.label}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
  );
}
