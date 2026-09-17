/**
 * The Keybindings page: the server-owned table behind `keybindings.get` /
 * `keybindings.update`. Shortcuts edit through the `shortcut` control (click,
 * press the chord), `when` clauses commit on blur, and "Reset to defaults"
 * restores the table the contracts publish. A binding only exists once it has
 * a shortcut — the schema requires one — so the add row collects both halves
 * before writing.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import { Kbd } from "@OpenAde/ui/components/kbd";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "@OpenAde/contracts/settings";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { Icon } from "@/lib/icon";

import { CommitInput, ShortcutInput } from "./schema-form";

export function KeybindingsPanel() {
  const atoms = useAppAtoms();
  const keybindingsResult = useAtomValue(atoms.keybindingsAtom);
  const update = useAtomSet(atoms.keybindingsUpdateAtom, { mode: "promiseExit" });
  const [draft, setDraft] = React.useState({ command: "", shortcut: "" });

  const keybindings = AsyncResult.isSuccess(keybindingsResult) ? keybindingsResult.value : null;

  const write = async (next: ReadonlyArray<Keybinding>) => {
    const exit = await update(next);
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save keybindings"));
    }
  };

  const setAt = (index: number, patch: Partial<Keybinding>) => {
    if (keybindings === null) {
      return;
    }
    // `shortcut` is non-empty by contract — a cleared capture leaves it as is.
    if (patch.shortcut === "") {
      return;
    }
    void write(keybindings.map((binding, i) => (i === index ? { ...binding, ...patch } : binding)));
  };

  const addBinding = () => {
    const command = draft.command.trim();
    if (command === "" || draft.shortcut === "" || keybindings === null) {
      return;
    }
    void write([...keybindings, { command, shortcut: draft.shortcut }]);
    setDraft({ command: "", shortcut: "" });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">Keybindings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Command-to-shortcut bindings. The notation is <Kbd>Cmd+Shift+B</Kbd> — Cmd is the
            platform modifier.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void write(DEFAULT_KEYBINDINGS)}
          disabled={keybindings === null}
        >
          Reset to defaults
        </Button>
      </div>

      <Card size="sm">
        <CardContent>
          <div className="flex flex-col divide-y divide-border/60">
            {keybindings === null ? (
              <p className="py-6 text-sm text-muted-foreground">Loading…</p>
            ) : keybindings.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">No keybindings configured.</p>
            ) : (
              keybindings.map((binding, index) => (
                <div key={`${binding.command}-${index}`} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {binding.command}
                  </span>
                  <div className="w-44">
                    <CommitInput
                      value={binding.when ?? ""}
                      placeholder="when…"
                      onCommit={(next) =>
                        setAt(index, next === "" ? { when: undefined } : { when: next })
                      }
                    />
                  </div>
                  <ShortcutInput
                    value={binding.shortcut}
                    onChange={(next) => setAt(index, { shortcut: next ?? "" })}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${binding.command}`}
                    onClick={() => void write(keybindings.filter((_, i) => i !== index))}
                  >
                    <Icon icon="hugeicons:delete-02" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <div className="w-72">
          <CommitInput
            value={draft.command}
            placeholder="command.id"
            onCommit={(next) => setDraft((d) => ({ ...d, command: next }))}
          />
        </div>
        <ShortcutInput
          value={draft.shortcut}
          onChange={(next) => setDraft((d) => ({ ...d, shortcut: next ?? "" }))}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={addBinding}
          disabled={draft.command.trim() === "" || draft.shortcut === ""}
        >
          <Icon icon="hugeicons:add-01" />
          Add binding
        </Button>
      </div>
    </div>
  );
}
