/**
 * Choose a folder on the machine the server runs on.
 *
 * The desktop shell has a native dialog and keeps it; this is what everywhere
 * else gets — a browser tab today, a client that is not on this machine later.
 * It reads `fs.browse` through `fsAtoms` like every other surface reads its
 * atoms, so it shares the app's one socket and relists by itself after a
 * reconnect.
 *
 * Deliberately plain: a path field, a breadcrumb, the subfolders, a hidden
 * toggle and one button that returns the current directory. No preview, no
 * multi-select, no favourites — the answer this produces is a single absolute
 * path, and everything that happens to it afterwards is the caller's existing
 * validation and create path.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { FsQuery } from "@OpenAde/client-runtime/fsAtoms";
import type { FsEntry, FsListing } from "@OpenAde/contracts/rpc";
import { Button } from "@OpenAde/ui/components/button";
import { Checkbox } from "@OpenAde/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@OpenAde/ui/components/dialog";
import { Input } from "@OpenAde/ui/components/input";
import { Label } from "@OpenAde/ui/components/label";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { Icon } from "@/lib/icon";
import { useConnectionState } from "@/state/hooks";

import { Breadcrumb, FolderList } from "./folder-list";
import { useFsAtoms } from "./fs-atoms";
import {
  completionsFor,
  cursorOn,
  fieldValue,
  highlighted,
  initialLocation,
  movedCursor,
  movedTo,
  pickerKeyAction,
  typed,
  type PickerLocation,
} from "./picker-state";

/** A block for every state that is not a folder full of folders. */
function PickerMessage({ icon, text }: { readonly icon: string; readonly text: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-border px-6 text-center">
      <Icon icon={icon} className="size-6 text-muted-foreground" />
      <p className="type-body text-muted-foreground">{text}</p>
    </div>
  );
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  initialPath,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What the caller's field already held; an absolute path opens there. */
  readonly initialPath: string;
  /** The chosen directory, in the server's own spelling of it. */
  readonly onPick: (path: string) => void;
}) {
  const atoms = useFsAtoms();
  const connected = useConnectionState().status === "connected";
  const [showHidden, setShowHidden] = React.useState(false);
  const [location, setLocation] = React.useState<PickerLocation>(() =>
    initialLocation(initialPath),
  );

  const browseAtom = atoms.directoryAtom({ path: location.path, showHidden });
  const result = useAtomValue(browseAtom);
  const retry = useAtomRefresh(browseAtom);

  // A stream that ended is the same news as a failed call, and the same button
  // fixes both: the atom's own failure channel never carries a server reason.
  const query: FsQuery | null = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? { _tag: "error", reason: "internal", message: "That folder could not be listed." }
      : null;
  const listing: FsListing | null = query?._tag === "ok" ? query.listing : null;

  const draft = fieldValue(location, listing);
  const completions = completionsFor(location.draft, listing);
  const entries = listing?.entries ?? [];

  const goTo = (path: string) => setLocation(movedTo(path));
  const parent = listing === null ? null : listing.parent;
  const goUp = () => {
    if (parent !== null) {
      goTo(parent);
    }
  };
  const descend = () => {
    const entry = highlighted(location, listing);
    if (entry !== null) {
      goTo(entry.path);
    }
  };
  const navigateTyped = () => {
    const wanted = draft.trim();
    if (wanted !== "") {
      goTo(wanted);
    }
  };

  const handleKey = (event: React.KeyboardEvent, inPathField: boolean) => {
    const action = pickerKeyAction({
      key: event.key,
      inPathField,
      draftEmpty: draft === "",
    });
    if (action === null) {
      return;
    }
    event.preventDefault();
    switch (action) {
      case "cursor-up":
        setLocation((current) => movedCursor(current, -1, entries.length));
        return;
      case "cursor-down":
        setLocation((current) => movedCursor(current, 1, entries.length));
        return;
      case "descend":
        descend();
        return;
      case "up":
        goUp();
        return;
      case "navigate-typed":
        navigateTyped();
    }
  };

  const openEntry = (entry: FsEntry) => goTo(entry.path);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Folders on the machine the server runs on. Enter opens the highlighted one; Backspace
            goes up.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="folder-picker-path">Path</Label>
            <Input
              id="folder-picker-path"
              value={draft}
              placeholder="/Users/you/code"
              autoFocus
              spellCheck={false}
              onChange={(event) => setLocation((current) => typed(current, event.target.value))}
              onKeyDown={(event) => handleKey(event, true)}
            />
            {completions.length === 0 ? null : (
              <div className="flex flex-wrap gap-1">
                {completions.slice(0, 8).map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => goTo(entry.path)}
                    className="rounded-lg bg-hover px-1.5 py-0.5 type-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Breadcrumb
            path={listing?.path ?? null}
            canGoUp={parent !== null}
            onGoUp={goUp}
            onNavigate={goTo}
          />

          {!connected ? (
            <PickerMessage icon="hugeicons:wifi-off-01" text="Not connected to the server." />
          ) : query === null ? (
            <PickerMessage icon="hugeicons:loading-03" text="Listing…" />
          ) : query._tag === "error" ? (
            <div className="flex flex-col items-center gap-2">
              <PickerMessage icon="hugeicons:alert-02" text={query.message} />
              <Button type="button" variant="ghost" size="sm" onClick={retry}>
                <Icon icon="hugeicons:refresh" className="size-3.5" />
                Try again
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <PickerMessage icon="hugeicons:folder-01" text="No folders in here." />
          ) : (
            <FolderList
              entries={entries}
              cursor={location.cursor}
              idPrefix="folder-picker-entry"
              onSelect={(index) =>
                setLocation((current) => cursorOn(current, index, entries.length))
              }
              onOpen={openEntry}
              onKeyDown={(event) => handleKey(event, false)}
            />
          )}

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 type-micro text-muted-foreground">
              <Checkbox
                checked={showHidden}
                onCheckedChange={(checked) => setShowHidden(checked === true)}
                aria-label="Show hidden folders"
              />
              Show hidden folders
            </label>
            {listing?.truncated === true ? (
              <span className="type-micro text-muted-foreground">
                First folders only — this one holds more.
              </span>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={listing === null}
            onClick={() => {
              if (listing !== null) {
                onPick(listing.path);
                onOpenChange(false);
              }
            }}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
