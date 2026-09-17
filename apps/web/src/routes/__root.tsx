import { useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Toaster } from "@OpenAde/ui/components/sonner";
import { HeadContent, Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { DiffWorkerPoolProvider } from "@/components/timeline/diff-pool";
import { useAppAtoms } from "@/lib/app-runtime";
import { ClientRuntimeBridge } from "@/lib/client-runtime";
import { Icon } from "@/lib/icon";
import { KeybindingsProvider } from "@/lib/shortcuts";
import { AppAtomRegistryProvider, getAppAtoms } from "@/state/app-runtime";

import "../index.css";

export interface RouterAppContext {}

/**
 * The shell's own 404. `/_home/t/$threadId` throws `notFound()` for a param
 * that is not a UUIDv7, and without this the user got the router's bare
 * default — a dead end with no way back into the app.
 */
function NotFound() {
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <Icon icon="hugeicons:link-broken-01" className="size-6 text-muted-foreground" />
      <p className="type-body text-muted-foreground">
        That page does not exist — the link may point at a thread that was deleted.
      </p>
      <Button type="button" variant="outline" render={<Link to="/" />}>
        Back to OpenAde
      </Button>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  head: () => ({
    meta: [
      {
        title: "OpenAde",
      },
      {
        name: "description",
        content: "OpenAde — a desktop workspace for running coding agents on your projects.",
      },
    ],
    // No `links`: index.html already declares /favicon.png and the touch icon.
    // The scaffold pointed at a /favicon.ico that does not exist, which 404'd
    // on every navigation.
  }),
});

/** Pushes the persisted `settings.theme` into next-themes whenever the doc changes. */
function SettingsThemeSync() {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const { setTheme } = useTheme();
  React.useEffect(() => {
    if (AsyncResult.isSuccess(result) && result.value !== null) {
      setTheme(result.value.theme);
    }
  }, [result, setTheme]);
  return null;
}

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <AppAtomRegistryProvider>
          <ClientRuntimeBridge runtime={getAppAtoms()}>
            <SettingsThemeSync />
            {/* The only keydown listener in the renderer — see @/lib/shortcuts. */}
            <KeybindingsProvider>
              <DiffWorkerPoolProvider>
                <Outlet />
                <Toaster richColors />
              </DiffWorkerPoolProvider>
            </KeybindingsProvider>
          </ClientRuntimeBridge>
        </AppAtomRegistryProvider>
      </ThemeProvider>
      {/* Dev only — the packaged app was shipping the floating devtools button. */}
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </>
  );
}
