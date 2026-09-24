import { RouterProvider, createRouter } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { resolveConnection } from "@poseidon/client-runtime/resolver";

import Loader from "./components/loader";
import { ErrorScreen } from "./components/Layout/error-screen";
import { applyCachedFontSizes } from "./lib/font-size";
import { routeTree } from "./routeTree.gen";
import { installAppAtoms } from "./state/app-runtime";

applyCachedFontSizes();

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  // The renderer's error boundary. Set here rather than on the root route so
  // it also covers a throw from the root component itself, which would
  // otherwise leave the router's bare default and no way back into the app.
  defaultErrorComponent: ({ error, reset }) => <ErrorScreen error={error} reset={reset} />,
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
