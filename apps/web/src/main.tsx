import { RouterProvider, createRouter } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { resolveConnection } from "@OpenAde/client-runtime/resolver";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";
import { installAppAtoms } from "./state/app-runtime";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  context: {},
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

/**
 * The connection resolves before first paint — the Electron preload, the dev
 * Vite endpoint, or `?server=&token=` params, in that order. `null` installs
 * the offline runtime so every atom still mounts and the banner explains.
 */
const bootstrap = async () => {
  installAppAtoms(await resolveConnection());
  if (!rootElement.innerHTML) {
    ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
  }
};

void bootstrap();
