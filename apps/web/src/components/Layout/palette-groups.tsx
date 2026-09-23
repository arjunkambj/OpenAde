/**
 * The command palette's groups. Every entry has to land on something real — a
 * palette that navigates to a blank pane, or offers a command no surface on
 * this route answers, is worse than one that is missing the entry.
 */

import { useNavigate } from "@tanstack/react-router";

import {
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@OpenAde/ui/components/command";
import type { ProjectId } from "@OpenAde/contracts/ids";

import { paletteThreads } from "@/components/Layout/palette-threads";
import { SETTINGS_PAGES } from "@/components/Layout/settings-sidebar";
import {
  SHORTCUT_COMMANDS,
  ShortcutKbd,
  useKeybindingDispatch,
  useKeybindingHandled,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useProjects, useThreadList } from "@/state/hooks";
import {
  Add,
  Archive,
  Chat,
  FolderAdd,
  Server,
  SidebarLeft,
  Sparkles,
  SquarePen,
} from "@honeyicons/react";

type GroupProps = { readonly onDone: () => void };

const navigationItems = [
  { to: "/", icon: SquarePen, label: "New task", shortcut: "newChat" },
  { to: "/customize/skills", icon: Sparkles, label: "Skills" },
  { to: "/customize/mcp", icon: Server, label: "MCP servers" },
] as const;

function ItemShortcut({ id }: { id?: ShortcutId }) {
  if (!id) {
    return null;
  }

  return (
    <CommandShortcut>
      <ShortcutKbd id={id} />
    </CommandShortcut>
  );
}

export function NavigationGroup({ onDone }: GroupProps) {
  const navigate = useNavigate();

  return (
    <CommandGroup heading="Navigation">
      {navigationItems.map((item) => (
        <CommandItem
          key={item.label}
          value={item.label}
          onSelect={() => {
            onDone();
            void navigate({ to: item.to });
          }}
        >
          <item.icon />
          {item.label}
          <ItemShortcut id={"shortcut" in item ? item.shortcut : undefined} />
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/**
 * One entry per settings page, straight from the settings sidebar's own list,
 * so a page added there shows up here without a second edit. The value says
 * "Settings" too, so typing it finds every page.
 */
export function SettingsGroup({ onDone }: GroupProps) {
  const navigate = useNavigate();

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="Settings">
        {SETTINGS_PAGES.map((page) => (
          <CommandItem
            key={page.to}
            value={`Settings ${page.label}`}
            onSelect={() => {
              onDone();
              void navigate({ to: page.to });
            }}
          >
            <page.icon />
            {page.label}
            <ItemShortcut id={page.to === "/settings" ? "settings" : undefined} />
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

/**
 * Things to do rather than places to go. Add project and Toggle sidebar fire
 * the command their surface claims, and are read on mount — this content
 * mounts on every open — so a route without that surface gets no row for it
 * instead of a row that quietly does nothing. Picking a project starts a
 * thread through the one create flow.
 */
export function ActionsGroup({ onDone }: GroupProps) {
  const fire = useKeybindingDispatch();
  const projects = useProjects();
  const { create } = useCreateThread();
  const canAddProject = useKeybindingHandled(SHORTCUT_COMMANDS.addProject);
  const canToggleSidebar = useKeybindingHandled(SHORTCUT_COMMANDS.toggle);

  if (!canAddProject && !canToggleSidebar && projects.length === 0) {
    return null;
  }

  const run = (command: string) => () => {
    onDone();
    fire(command);
  };

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="Actions">
        {canAddProject ? (
          <CommandItem value="Add project" onSelect={run(SHORTCUT_COMMANDS.addProject)}>
            <FolderAdd />
            Add project
            <ItemShortcut id="addProject" />
          </CommandItem>
        ) : null}
        {projects.map((project) => (
          <CommandItem
            key={project.projectId}
            value={`New thread in ${project.name}`}
            onSelect={() => {
              onDone();
              void create(project.projectId);
            }}
          >
            <Add />
            New thread in {project.name}
          </CommandItem>
        ))}
        {canToggleSidebar ? (
          <CommandItem value="Toggle sidebar" onSelect={run(SHORTCUT_COMMANDS.toggle)}>
            <SidebarLeft />
            Toggle sidebar
            <ItemShortcut id="toggle" />
          </CommandItem>
        ) : null}
      </CommandGroup>
    </>
  );
}

/**
 * The threads the palette can reach. A palette in a multi-thread app that
 * cannot find a thread is a menu, so the list comes from the live atoms.
 *
 * Archived threads are off the sidebar but stay reachable here, listed after
 * the live ones, marked, and matched by typing "archived".
 */
export function ThreadsGroup({ onDone }: GroupProps) {
  const navigate = useNavigate();
  const threads = useThreadList();
  const projects = useProjects();

  if (threads.length === 0) {
    return null;
  }

  const projectName = (projectId: ProjectId): string =>
    projects.find((project) => project.projectId === projectId)?.name ?? "Other threads";

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="Threads">
        {paletteThreads(threads).map((thread) => {
          const archived = thread.status === "archived";
          return (
            <CommandItem
              key={thread.threadId}
              value={`${thread.title} ${projectName(thread.projectId)} ${thread.threadId}${archived ? " archived" : ""}`}
              onSelect={() => {
                onDone();
                void navigate({ to: "/t/$threadId", params: { threadId: thread.threadId } });
              }}
            >
              {archived ? <Archive /> : <Chat />}
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 type-micro text-muted-foreground">
                {archived
                  ? `Archived · ${projectName(thread.projectId)}`
                  : projectName(thread.projectId)}
              </span>
            </CommandItem>
          );
        })}
      </CommandGroup>
    </>
  );
}
