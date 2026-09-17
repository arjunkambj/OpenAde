import { Toaster } from "@OpenAde/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { ThemeProvider } from "@/components/theme-provider";
import { DiffWorkerPoolProvider } from "@/components/timeline/diff-pool";
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
