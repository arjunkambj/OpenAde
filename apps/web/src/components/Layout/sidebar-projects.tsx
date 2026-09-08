import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@OpenAde/ui/components/sidebar";

import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";

const projects = [
  { id: "aurora-studio", name: "aurora-studio" },
  {
    id: "orbit-dashboard",
    name: "orbit-dashboard",
    tasks: [
      { id: "auth", name: "Auth screen UI improvements", time: "3mo" },
      { id: "general", name: "General chat", time: "3mo" },
    ],
  },
  { id: "paperplane", name: "paperplane" },
  { id: "bloom-notes", name: "bloom-notes" },
  { id: "copper-api", name: "copper-api" },
] as const;

const filters = [
  { value: "all", label: "All projects" },
  { value: "recent", label: "Recent" },
  { value: "folders", label: "Folders" },
] as const;

export function SidebarProjects() {
  const [filter, setFilter] = React.useState("all");
  const [selectedTask, setSelectedTask] = React.useState("auth");

  return (
    <SidebarGroup className="min-h-0 flex-1 px-2 pt-6">
      <div className="flex h-8 items-center gap-1">
        <SidebarGroupLabel className="h-auto flex-1 px-2">Projects</SidebarGroupLabel>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Filter projects" />
            }
          >
            <Icon icon="hugeicons:filter" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuRadioGroup value={filter} onValueChange={(value) => setFilter(value)}>
              {filters.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>
                  {item.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Add project">
          <Icon icon="hugeicons:folder-add" />
        </Button>
      </div>
      <SidebarGroupContent className="mt-1 min-h-0 overflow-y-auto [scrollbar-width:none]">
        <div className="grid min-w-0 gap-0.5">
          {projects.map((project) => (
            <React.Fragment key={project.id}>
              <div className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm text-sidebar-foreground transition-[background-color,color] duration-150 ease-out">
                <Icon
                  icon="hugeicons:folder-01"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate">{project.name}</span>
              </div>
              {"tasks" in project
                ? project.tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      aria-current={selectedTask === task.id ? "page" : undefined}
                      className={cn(
                        "flex h-8 min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 pl-[34px] text-left text-[13px] text-sidebar-foreground outline-none transition-[background-color,color] duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        selectedTask === task.id &&
                          "bg-sidebar-accent text-sidebar-accent-foreground",
                      )}
                      onClick={() => setSelectedTask(task.id)}
                    >
                      <span className="min-w-0 truncate">{task.name}</span>
                      <time className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {task.time}
                      </time>
                    </button>
                  ))
                : null}
            </React.Fragment>
          ))}
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
