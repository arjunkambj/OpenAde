/**
 * The Browser page: whether the pane opens on its own when the agent starts
 * using the browser (off by default), how the in-app browser is attached and
 * what that exposes, the `agent-browser` CLI's status with its install
 * command, and clearing the browsing data every thread's tabs keep.
 */
import * as React from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Badge } from "@poseidon/ui/components/badge";
import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import { Label } from "@poseidon/ui/components/label";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyCommand } from "@/components/copy-command";
import { useBrowserAtoms } from "@/components/panes/browser/browser-atoms";
import { installCommands } from "@/components/panes/browser/install";
import { useAppAtoms } from "@/lib/app-runtime";
import { useClearBrowserHistory } from "@/state/browser-history";

import { modeLabel, statusLabel } from "./browser-status";

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {description === undefined ? null : (
        <div className="text-sm text-muted-foreground">{description}</div>
      )}
      {children}
    </section>
  );
}

function AutoOpen() {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const update = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });
  const settings = AsyncResult.isSuccess(result) ? result.value : null;
  const checked = settings?.browser.openPaneOnAgentUse ?? false;
  return (
    <Section
      title="When the agent uses the browser"
      description="The browser pane stays closed by default. The agent works in a hidden tab and the thread header shows “Agent is using the browser” with a Show button."
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id="browser-auto-open"
          checked={checked}
          disabled={settings === null}
          onCheckedChange={(next) =>
            update({ browser: { ...settings?.browser, openPaneOnAgentUse: next === true } })
          }
        />
        <Label htmlFor="browser-auto-open">
          Open the browser pane when the agent starts using it
        </Label>
      </div>
    </Section>
  );
}

function HowItAttaches() {
  return (
    <Section
      title="How the agent reaches the browser"
      description={
        <div className="flex flex-col gap-2">
          <p>
            In the desktop app the agent drives this thread’s own tabs in the browser pane — the
            same pages you see, with your logins in that thread. It connects through a private local
            endpoint that reaches only that thread’s tabs, never the Poseidon window, other threads
            or the rest of your computer’s browsers. Chrome’s remote-debugging port stays closed.
          </p>
          <p>
            Each thread keeps its own cookies and storage. Anything you do in a tab interrupts the
            agent’s current step, and it is told so. Starting the app with{" "}
            <code className="font-mono">POSEIDON_REMOTE_DEBUG=0</code> turns the agent’s browser off
            entirely.
          </p>
        </div>
      }
    />
  );
}

function ToolStatus() {
  const result = useAtomValue(useBrowserAtoms().browserStatusAtom);
  const status = AsyncResult.isSuccess(result) ? result.value : null;
  const mode = status === null ? null : modeLabel(status);
  return (
    <Section
      title="agent-browser"
      description="The command-line tool the agent drives the browser with. It is installed separately."
    >
      {status === null ? (
        <p className="text-sm text-muted-foreground">Asking the server…</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status.installed ? "secondary" : "outline"}>
              {statusLabel(status)}
            </Badge>
            {mode === null ? null : <span className="text-sm text-muted-foreground">{mode}</span>}
          </div>
          {status.installed ? null : (
            <div className="flex flex-col gap-1.5">
              {installCommands(status.mode).map((entry) => (
                <div key={entry.command} className="flex items-center gap-2">
                  <CopyCommand command={entry.command} />
                  <span className="text-xs text-muted-foreground">{entry.note}</span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Restart Poseidon after installing so the server finds it.
              </p>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function ClearData() {
  const [open, setOpen] = React.useState(false);
  const clearHistory = useClearBrowserHistory();
  const clearAll = window.poseidon?.browserPane?.clearAll;

  const clear = async () => {
    clearHistory();
    try {
      await clearAll?.();
      toast.success("Cleared browsing data");
    } catch {
      toast.error("Could not clear the tabs’ browsing data");
    }
  };

  return (
    <Section
      title="Browsing data"
      description={
        clearAll === undefined
          ? "Forget the pages the address bar suggests."
          : "Forget the pages the address bar suggests, and sign out of every site: each thread’s cookies, storage and cache are cleared."
      }
    >
      <div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Clear browsing data
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Clear browsing data?"
        description={
          clearAll === undefined
            ? "The address bar’s history for every project is removed."
            : "The address bar’s history for every project is removed, and every thread’s tabs lose their cookies, storage and cache. Open tabs stay open."
        }
        confirmLabel="Clear"
        onConfirm={() => void clear()}
      />
    </Section>
  );
}

export function BrowserPanel() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Browser</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The browser pane the agent can drive in each thread.
        </p>
      </div>
      <AutoOpen />
      <HowItAttaches />
      <ToolStatus />
      <ClearData />
    </div>
  );
}
