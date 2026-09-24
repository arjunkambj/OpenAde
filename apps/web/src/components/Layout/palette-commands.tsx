/**
 * The palette's commands, straight from the command catalog, one group per
 * area. A command is listed only while a mounted surface answers it (and its
 * `paletteWhen`, if any, holds), so a route without the surface gets no row
 * rather than a row that quietly does nothing. Picking a row fires the command
 * as its chord would, marked as a `pick` so a handler that reads the focus
 * knows the palette holds it, and the row shows that chord with the user's
 * overrides applied.
 */

import { Fragment } from "react";

import { CommandGroup, CommandItem, CommandSeparator } from "@poseidon/ui/components/command";

import { ItemShortcut } from "@/components/Layout/palette-groups";
import { COMMAND_AREAS, COMMAND_CATALOG, type CommandArea } from "@/lib/command-catalog";
import { useCommandAvailable, useKeybindingDispatch } from "@/lib/shortcuts";

/** "Threads" is the thread list's heading, so its commands take another. */
const HEADINGS: Readonly<Record<CommandArea, string>> = {
  General: "General",
  Threads: "Thread actions",
  Composer: "Composer",
  View: "View",
  Timeline: "Timeline",
  Git: "Git",
  Cards: "Pending request",
};

export function PaletteCommands({ onDone }: { readonly onDone: () => void }) {
  const available = useCommandAvailable();
  const fire = useKeybindingDispatch();
  const offered = COMMAND_CATALOG.filter(
    (entry) => entry.palette && available(entry.id, entry.paletteWhen),
  );

  return (
    <>
      {COMMAND_AREAS.map((area) => {
        const rows = offered.filter((entry) => entry.area === area);
        if (rows.length === 0) {
          return null;
        }
        return (
          <Fragment key={area}>
            <CommandSeparator />
            <CommandGroup heading={HEADINGS[area]}>
              {rows.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${entry.title} ${entry.description ?? ""} ${area}`}
                  onSelect={() => {
                    onDone();
                    fire(entry.id);
                  }}
                >
                  {entry.icon === undefined ? null : <entry.icon variant="bold" />}
                  {entry.title}
                  <ItemShortcut command={entry.id} />
                </CommandItem>
              ))}
            </CommandGroup>
          </Fragment>
        );
      })}
    </>
  );
}
