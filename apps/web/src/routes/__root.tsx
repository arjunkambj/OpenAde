import { useAtomValue } from "@effect/atom-react";
import { Toaster } from "@OpenAde/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { DiffWorkerPoolProvider } from "@/components/timeline/diff-pool";
import { useAppAtoms } from "@/lib/app-runtime";
import { AppAtomRegistryProvider } from "@/state/app-runtime";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "OpenAde",
      },
      {
        name: "description",
        content: "OpenAde is a web application",
      },
    ],
    links: [
      {
        rel: "icon",
        href: "/favicon.ico",
      },
    ],
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
          <SettingsThemeSync />
          <DiffWorkerPoolProvider>
            <Outlet />
            <Toaster richColors />
          </DiffWorkerPoolProvider>
        </AppAtomRegistryProvider>
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-right" />
    </>
  );
}
