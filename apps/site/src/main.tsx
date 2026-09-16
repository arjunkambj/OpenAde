import { createRoot, hydrateRoot } from "react-dom/client";

import { App } from "./app";

import "./index.css";

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

// The deployed page is prerendered; `vite dev` serves an empty mount point.
if (rootElement.hasChildNodes()) {
  hydrateRoot(rootElement, <App />);
} else {
  createRoot(rootElement).render(<App />);
}
