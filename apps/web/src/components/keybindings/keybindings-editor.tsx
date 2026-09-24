/**
 * The keybindings editor: a VS Code-style table over the effective keymap —
 * rebind by capturing a chord, narrow with a `when` clause, add a row, remove
 * one, reset one to the shipped default, or restore the whole table.
 * Conflicts (two bindings on the same chord in the same scope — the first
 * always wins) are flagged inline.
 *
 * The draft is the table the dispatcher actually resolves against —
 * `effectiveKeybindings`, the shipped defaults with the user's overrides
 * layered on — so what the page shows is what the keys do. Save posts only the
 * difference from the defaults (`diffKeymap`) through `keybindings.update`: a
 * command left at its default stores nothing and keeps following the defaults,
 * and a command whose last row was removed is stored as unbound and stays so.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@OpenAde/ui/components/empty";
import { Input } from "@OpenAde/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@OpenAde/ui/components/tooltip";
import { cn } from "@OpenAde/ui/lib/utils";
import type { Keybinding } from "@OpenAde/contracts/settings";
import { DEFAULT_KEYBINDINGS, diffKeymap } from "@OpenAde/contracts/keybindings";
import { findKeybindingConflicts, parseShortcut } from "@OpenAde/client-runtime/keybindings";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { ShortcutRecorder } from "@/components/keybindings/shortcut-recorder";
import { useClientRuntime } from "@/lib/client-runtime";
import { effectiveKeybindings } from "@/lib/keybindings";
import { Add as AddIcon, AlertTriangle, Close, Keyboard, Undo } from "@honeyicons/react";

/** Rows whose (shortcut, when) pair collides with an earlier row. */
const conflictCommands = (keybindings: ReadonlyArray<Keybinding>): ReadonlySet<string> =>
  new Set(
    findKeybindingConflicts(keybindings)
      .flat()
      .map((binding) => binding.command),
  );

const sameTable = (a: ReadonlyArray<Keybinding>, b: ReadonlyArray<Keybinding>): boolean =>
  a.length === b.length &&
  a.every(
    (row, i) =>
      row.command === b[i]?.command && row.shortcut === b[i]?.shortcut && row.when === b[i]?.when,
  );

export function KeybindingsEditor({ className }: { readonly className?: string }) {
  const { keybindingsAtom, keybindingsUpdateAtom } = useClientRuntime();
  const result = useAtomValue(keybindingsAtom);
  // The same table `@/lib/shortcuts` dispatches against, so what the page
  // shows is what the keys do.
  const serverTable = React.useMemo(
    () => effectiveKeybindings(AsyncResult.isSuccess(result) ? result.value : []),
    [result],
  );
  const update = useAtomSet(keybindingsUpdateAtom, { mode: "promise" });

  const [draft, setDraft] = React.useState<ReadonlyArray<Keybinding>>(serverTable);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState({ command: "", shortcut: "" });

  // Follow the server table while there is no pending edit.
  React.useEffect(() => {
    setDraft((current) => (sameTable(current, serverTable) ? current : serverTable));
  }, [serverTable]);

  const dirty = !sameTable(draft, serverTable);
  const conflicts = React.useMemo(() => conflictCommands(draft), [draft]);

  const patchRow = (index: number, patch: Partial<Keybinding>) =>
    setDraft((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const resetRow = (index: number) =>
    setDraft((current) => {
      const row = current[index];
      const fallback = DEFAULT_KEYBINDINGS.find((entry) => entry.command === row?.command);
      return row === undefined || fallback === undefined
        ? current
        : current.map((r, i) => (i === index ? { ...r, shortcut: fallback.shortcut } : r));
    });

  const addRow = () => {
    const command = added.command.trim();
    if (command === "" || added.shortcut === "") {
      return;
    }
    setDraft((current) => [...current, { command, shortcut: added.shortcut }]);
    setAdded({ command: "", shortcut: "" });
  };

  const save = () => {
    setSaving(true);
    setError(null);
    void update(diffKeymap(DEFAULT_KEYBINDINGS, draft)).then(
      () => setSaving(false),
      () => {
        setSaving(false);
        setError("the server rejected the keybinding table");
      },
    );
  };

  return (
    <TooltipProvider>
      <section className={cn("flex min-w-0 flex-col gap-2", className)} aria-label="Keybindings">
        {/* No heading of its own: the page above it names the section, and the
            `aria-label` on the section covers the dev fixture that mounts it
            without one. */}
        <div className="flex items-center gap-2">
          <span className="ml-auto flex items-center gap-2">
            {dirty ? <span className="text-xs text-muted-foreground">unsaved</span> : null}
            <Button
              size="sm"
              variant="ghost"
              tone="muted"
              disabled={saving || sameTable(draft, DEFAULT_KEYBINDINGS)}
              onClick={() => setDraft(DEFAULT_KEYBINDINGS)}
            >
              Restore defaults
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!dirty || saving}
              onClick={() => setDraft(serverTable)}
            >
              Revert
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </span>
        </div>
        <div className="min-w-0 overflow-x-auto rounded-xl bg-card">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Command</th>
                <th className="px-3 py-2 font-medium">Shortcut</th>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {draft.map((row, index) => {
                const conflicted = conflicts.has(row.command);
                const shortcutValid = parseShortcut(row.shortcut) !== null;
                return (
                  <tr key={`${row.command}-${index}`}>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5 font-mono text-xs">
                        {row.command}
                        {conflicted ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={<span className="inline-flex text-permission" />}
                            >
                              <AlertTriangle variant="bold" className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Another binding on this chord wins — only the first match fires.
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <ShortcutRecorder
                        value={row.shortcut}
                        onRecord={(shortcut) => patchRow(index, { shortcut })}
                      />
                      {shortcutValid ? null : (
                        <span className="ml-1.5 text-xs text-destructive">invalid chord</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        value={row.when ?? ""}
                        placeholder="always"
                        aria-label={`When clause for ${row.command}`}
                        onChange={(event) =>
                          patchRow(index, {
                            when: event.target.value === "" ? undefined : event.target.value,
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                tone="muted"
                                size="icon-sm"
                                aria-label={`Reset ${row.command} to the default shortcut`}
                                onClick={() => resetRow(index)}
                              />
                            }
                          >
                            <Undo variant="bold" />
                          </TooltipTrigger>
                          <TooltipContent>Reset to default</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                tone="muted"
                                size="icon-sm"
                                aria-label={`Remove binding for ${row.command}`}
                                onClick={() =>
                                  setDraft((current) => current.filter((_, i) => i !== index))
                                }
                              />
                            }
                          >
                            <Close variant="bold" />
                          </TooltipTrigger>
                          <TooltipContent>Remove binding</TooltipContent>
                        </Tooltip>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {draft.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Keyboard variant="bold" />
                        </EmptyMedia>
                        <EmptyTitle>Nothing is bound</EmptyTitle>
                        <EmptyDescription>
                          Every binding was removed. Add one below, or restore the defaults.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </td>
                </tr>
              ) : null}
              <tr>
                <td className="px-3 py-1.5">
                  <Input
                    value={added.command}
                    placeholder="command.id"
                    aria-label="New binding command"
                    onChange={(event) =>
                      setAdded((current) => ({ ...current, command: event.target.value }))
                    }
                  />
                </td>
                <td className="px-3 py-1.5">
                  <ShortcutRecorder
                    value={added.shortcut === "" ? "press keys" : added.shortcut}
                    onRecord={(shortcut) => setAdded((current) => ({ ...current, shortcut }))}
                  />
                </td>
                <td className="px-3 py-1.5" />
                <td className="px-3 py-1.5">
                  <span className="flex items-center justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={added.command.trim() === "" || added.shortcut === ""}
                      onClick={addRow}
                    >
                      <AddIcon variant="bold" />
                      Add binding
                    </Button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {error === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </section>
    </TooltipProvider>
  );
}
