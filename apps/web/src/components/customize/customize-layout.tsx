/**
 * The Customize page: what extends the agent, one tab per kind. The tab bar
 * reads from `CUSTOMIZE_TABS`, so a new kind (plugins, rules, hooks) is one
 * entry plus its route — and nothing is listed before it has a route that
 * works.
 *
 * The project scope picker lives here rather than in each tab because every
 * kind is resolved against the same context: global, or global plus one
 * project. Switching tabs keeps it.
 */

import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import { cn } from "@OpenAde/ui/lib/utils";
import type { ProjectId } from "@OpenAde/contracts/ids";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { scopeLabel, USER_SCOPE, USER_SCOPE_LABEL } from "@/components/Settings/select-label";
import { useAppAtoms } from "@/lib/app-runtime";
import { Icon } from "@/lib/icon";

const CUSTOMIZE_TABS = [
  { to: "/customize/skills", label: "Skills", icon: "hugeicons:magic-wand-01", count: "skills" },
  { to: "/customize/mcp", label: "MCP", icon: "hugeicons:server-stack-01", count: "mcp" },
] as const;

const CustomizeScopeContext = React.createContext<ProjectId | null>(null);

/** The project the tabs resolve against — `null` is global only. */
export const useCustomizeScope = () => React.useContext(CustomizeScopeContext);

export function CustomizeLayout() {
  const atoms = useAppAtoms();
  const matchRoute = useMatchRoute();
  const projectsResult = useAtomValue(atoms.projectsAtom);
  const [projectId, setProjectId] = React.useState<ProjectId | null>(null);
  const skillsResult = useAtomValue(atoms.skillsAtom(projectId));
  const serversResult = useAtomValue(atoms.mcpServersAtom(projectId));

  const projects = AsyncResult.isSuccess(projectsResult) ? projectsResult.value : [];
  const counts = {
    skills: AsyncResult.isSuccess(skillsResult) ? skillsResult.value.length : null,
    mcp: AsyncResult.isSuccess(serversResult) ? serversResult.value.length : null,
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <h1 className="text-2xl font-medium">Customize</h1>

        <div className="flex items-center justify-between gap-4 border-b border-border/60">
          <nav className="-mb-px flex items-center gap-1" aria-label="Customize">
            {CUSTOMIZE_TABS.map((tab) => {
              const active = Boolean(matchRoute({ to: tab.to }));
              const count = counts[tab.count];
              return (
                <Link
                  key={tab.to}
                  to={tab.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm transition-colors",
                    active
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon icon={tab.icon} className="size-4" />
                  {tab.label}
                  {count === null ? null : (
                    <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="pb-2">
            <Select
              value={projectId ?? USER_SCOPE}
              onValueChange={(next) =>
                setProjectId(next === USER_SCOPE ? null : (next as ProjectId))
              }
            >
              <SelectTrigger size="sm" className="w-48">
                <SelectValue>{(value) => scopeLabel(value, projects)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={USER_SCOPE}>{USER_SCOPE_LABEL}</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.projectId} value={project.projectId}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <CustomizeScopeContext.Provider value={projectId}>
          <Outlet />
        </CustomizeScopeContext.Provider>
      </div>
    </div>
  );
}
