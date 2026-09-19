import * as React from "react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "@OpenAde/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@OpenAde/ui/components/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ProjectId } from "@OpenAde/contracts/ids";

import {
  SHORTCUT_COMMANDS,
  ShortcutKbd,
  useKeybindingCommand,
  useKeybindingDispatch,
  useKeybindingHandled,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useProjects, useThreadList } from "@/state/hooks";
import {
  Add,
  Close,
  Search as SearchIcon,
  Settings as SettingsIcon,
  SidebarLeft,
} from "@honeyicons/react";

type SearchContextValue = {
  setOpen: (open: boolean) => void;
};

const SearchContext = React.createContext<SearchContextValue | null>(null);

/**
 * The palette handle. Deliberately not exported: `SearchProvider` claims
 * `commandPalette.toggle` itself, so no surface outside this file needs to
 * reach in and open the palette.
 */
function useSearch() {
  const context = React.useContext(SearchContext);
  if (!context) {
    throw new Error("useSearch must be used within a SearchProvider.");
  }
  return context;
}

/**
 * Every entry here has to land on something real — a palette that navigates to
 * a blank pane is worse than one that is missing the entry.
 */
const searchItems = [
  {
    to: "/",
    icon: Add,
    label: "New task",
    shortcut: "newChat",
  },
  { to: "/customize/skills", icon: Close, label: "Skills" },
  { to: "/customize/mcp", icon: Close, label: "MCP servers" },
  { to: "/settings/connectors", icon: Close, label: "Connectors" },
  {
    to: "/settings",
    icon: SettingsIcon,
    label: "Settings",
    shortcut: "settings",
  },
] as const;

/**
 * Mounted once at the app root, not inside a layout: these commands are
 * route-independent, and while they were claimed inside `HomeLayout` the
 * palette, New task and Settings chords all did nothing on `/settings/*`.
 * `sidebar.toggle` is the exception — it belongs to whichever
 * sidebar is on screen, so each layout claims it through
 * `SidebarToggleShortcut` and this file only *fires* it.
 */
export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const value = React.useMemo(() => ({ setOpen }), []);

  // Handlers only — the chords come from the settings-owned keybinding table
  // and the one listener above the routes (@/lib/shortcuts). The palette is a
  // modal dialog over the route, so every navigating handler closes it first.
  const go = React.useCallback(
    (to: "/" | "/customize/skills" | "/settings") => () => {
      setOpen(false);
      void navigate({ to });
    },
    [navigate],
  );

  useKeybindingCommand(SHORTCUT_COMMANDS.search, () => setOpen((current) => !current));
  useKeybindingCommand(SHORTCUT_COMMANDS.newChat, go("/"));
  useKeybindingCommand(SHORTCUT_COMMANDS.skills, go("/customize/skills"));
  useKeybindingCommand(SHORTCUT_COMMANDS.settings, go("/settings"));

  return (
    <SearchContext.Provider value={value}>
      {children}
      <SearchDialog open={open} onOpenChange={setOpen} />
    </SearchContext.Provider>
  );
}

export function SearchTrigger({ className }: { className?: string }) {
  const { setOpen } = useSearch();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            onClick={() => setOpen(true)}
          />
        }
      >
        <SearchIcon />
        <span className="sr-only">Search</span>
      </TooltipTrigger>
      <TooltipContent>
        Search
        <ShortcutKbd id="search" />
      </TooltipContent>
    </Tooltip>
  );
}

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

/**
 * The threads and projects the palette can reach. A palette in a multi-thread
 * app that cannot find a thread is a menu, so both lists come from the live
 * atoms; picking a project starts a thread through the one create flow.
 */
function LiveGroups({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const threads = useThreadList();
  const projects = useProjects();
  const { create } = useCreateThread();

  const projectName = (projectId: ProjectId): string =>
    projects.find((project) => project.projectId === projectId)?.name ?? "Other threads";

  return (
    <>
      {threads.length === 0 ? null : (
        <>
          <CommandSeparator />
          <CommandGroup heading="Threads">
            {threads.map((thread) => (
              <CommandItem
                key={thread.threadId}
                value={`${thread.title} ${projectName(thread.projectId)} ${thread.threadId}`}
                onSelect={() => {
                  onDone();
                  void navigate({ to: "/t/$threadId", params: { threadId: thread.threadId } });
                }}
              >
                <Close />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 type-micro text-muted-foreground">
                  {projectName(thread.projectId)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      )}
      {projects.length === 0 ? null : (
        <>
          <CommandSeparator />
          <CommandGroup heading="Start a thread">
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
          </CommandGroup>
        </>
      )}
    </>
  );
}

function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const fire = useKeybindingDispatch();
  // Read on mount, and this content mounts on every open: a route whose
  // layout has no collapsible sidebar gets no row for it, instead of a row
  // that quietly does nothing.
  const canToggleSidebar = useKeybindingHandled(SHORTCUT_COMMANDS.toggle);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search">
      <Command>
        <CommandInput placeholder="Search threads and commands…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Navigation">
            {searchItems.map((item) => (
              <CommandItem
                key={item.label}
                value={item.label}
                onSelect={() => {
                  onOpenChange(false);
                  void navigate({ to: item.to });
                }}
              >
                <item.icon />
                {item.label}
                <ItemShortcut id={"shortcut" in item ? item.shortcut : undefined} />
              </CommandItem>
            ))}
          </CommandGroup>
          {canToggleSidebar ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="View">
                <CommandItem
                  value="Toggle sidebar"
                  onSelect={() => {
                    onOpenChange(false);
                    fire(SHORTCUT_COMMANDS.toggle);
                  }}
                >
                  <SidebarLeft />
                  Toggle sidebar
                  <ItemShortcut id="toggle" />
                </CommandItem>
              </CommandGroup>
            </>
          ) : null}
          <LiveGroups onDone={() => onOpenChange(false)} />
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
