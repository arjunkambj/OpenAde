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

import { Icon } from "@/lib/icon";
import { matchShortcut, ShortcutKbd, type ShortcutId } from "@/lib/shortcuts";

type SearchContextValue = {
  setOpen: (open: boolean) => void;
};

const SearchContext = React.createContext<SearchContextValue | null>(null);

function useSearch() {
  const context = React.useContext(SearchContext);
  if (!context) {
    throw new Error("useSearch must be used within a SearchProvider.");
  }
  return context;
}

const searchItems = [
  {
    to: "/",
    icon: "solar:add-linear",
    label: "New chat",
    shortcut: "newChat",
  },
  {
    to: "/skills",
    icon: "solar:layers-minimalistic-linear",
    label: "Skills",
    shortcut: "skills",
  },
  { to: "/settings/uses", icon: "solar:bolt-linear", label: "Uses" },
  {
    to: "/settings",
    icon: "solar:settings-linear",
    label: "Settings",
    shortcut: "settings",
  },
] as const;

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const value = React.useMemo(() => ({ setOpen }), []);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (matchShortcut("search", event)) {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }

      if (matchShortcut("newChat", event)) {
        event.preventDefault();
        setOpen(false);
        void navigate({ to: "/" });
        return;
      }

      if (matchShortcut("skills", event)) {
        event.preventDefault();
        setOpen(false);
        void navigate({ to: "/skills" });
        return;
      }

      if (matchShortcut("settings", event)) {
        event.preventDefault();
        setOpen(false);
        void navigate({ to: "/settings" });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

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
        <Icon icon="solar:magnifer-linear" />
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
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Navigation">
            {searchItems.map((item) => (
              <CommandItem
                key={item.to}
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
              <Icon icon="solar:sidebar-minimalistic-linear" className="rotate-180" />
              Toggle sidebar
              <ItemShortcut id="toggle" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
