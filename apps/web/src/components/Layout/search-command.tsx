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
import { useSidebar } from "@OpenAde/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import type { ProjectId } from "@OpenAde/contracts/ids";

import { Icon } from "@/lib/icon";
import {
  SHORTCUT_COMMANDS,
  ShortcutKbd,
  useKeybindingCommand,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useProjects, useThreadList } from "@/state/hooks";

type SearchContextValue = {
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const SearchContext = React.createContext<SearchContextValue | null>(null);

/**
 * The palette handle. The home layout uses it to bind the server-owned
 * `commandPalette.toggle` keybinding — the palette itself listens for no
 * shortcut it shares with that table, so the key is handled exactly once.
 */
export function useSearch() {
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
    icon: "hugeicons:add-01",
    label: "New task",
    shortcut: "newChat",
  },
  { to: "/settings/skills", icon: "hugeicons:magic-wand-01", label: "Skills" },
  { to: "/settings/connectors", icon: "hugeicons:plug-01", label: "Connectors" },
  {
    to: "/settings",
    icon: "hugeicons:settings-01",
    label: "Settings",
    shortcut: "settings",
  },
] as const;

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const value = React.useMemo(
    () => ({ setOpen, toggle: () => setOpen((current) => !current) }),
    [],
  );

  // Handlers only — the chords come from the settings-owned keybinding table
  // and the one listener above the routes (@/lib/shortcuts). The palette is a
  // modal dialog over the route, so every navigating handler closes it first.
  const go = React.useCallback(
    (to: "/" | "/settings/skills" | "/settings") => () => {
      setOpen(false);
      void navigate({ to });
    },
    [navigate],
  );

  useKeybindingCommand(SHORTCUT_COMMANDS.search, () => setOpen((current) => !current));
  useKeybindingCommand(SHORTCUT_COMMANDS.toggle, toggleSidebar);
  useKeybindingCommand(SHORTCUT_COMMANDS.newChat, go("/"));
  useKeybindingCommand(SHORTCUT_COMMANDS.skills, go("/settings/skills"));
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
        <Icon icon="hugeicons:search-01" />
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
                <Icon icon="hugeicons:message-01" />
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
                <Icon icon="hugeicons:add-01" />
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
  const { toggleSidebar } = useSidebar();

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
                <Icon icon={item.icon} />
                {item.label}
                <ItemShortcut id={"shortcut" in item ? item.shortcut : undefined} />
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="View">
            <CommandItem
              value="Toggle sidebar"
              onSelect={() => {
                onOpenChange(false);
                toggleSidebar();
              }}
            >
              <Icon icon="hugeicons:layout-left" />
              Toggle sidebar
              <ItemShortcut id="toggle" />
            </CommandItem>
          </CommandGroup>
          <LiveGroups onDone={() => onOpenChange(false)} />
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
