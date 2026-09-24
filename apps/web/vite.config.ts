import { existsSync, readFileSync } from "node:fs";
import { devConnectionPath } from "@poseidon/shared/paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Resolved through the shared paths module so an `POSEIDON_HOME` override moves
// the dev handshake file for the plugin and the server alike. Node-side config,
// never bundled into the renderer.
const DEV_CONNECTION_PATH = devConnectionPath();

const DEV_PORT = 3001;

/** This dev server's own origins — the only ones allowed to read the token. */
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${DEV_PORT}`,
  `http://127.0.0.1:${DEV_PORT}`,
  `http://[::1]:${DEV_PORT}`,
]);

/**
 * Serves `~/.poseidon/dev/connection.json` at `/__poseidon/connection` so a
 * browser renderer can find a dev-mode server without Electron. Dev-only —
 * the production build embeds the desktop's preload channel instead.
 *
 * The body is the bearer token for a socket that accepts
 * `orchestration.dispatch`, so a cross-origin read is refused: a page served
 * by some other local dev server must not be able to fetch it. A request with
 * no `Origin` header is same-origin navigation or a non-browser client, which
 * is the normal case here.
 */
const poseidonConnection = (): Plugin => ({
  name: "poseidon-connection",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__poseidon/connection", (req, res) => {
      const origin = req.headers.origin;
      if (typeof origin === "string" && !ALLOWED_ORIGINS.has(origin)) {
        res.statusCode = 403;
        res.end("cross-origin read refused");
        return;
      }
      if (!existsSync(DEV_CONNECTION_PATH)) {
        res.statusCode = 404;
        res.end("no dev server running");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(readFileSync(DEV_CONNECTION_PATH, "utf8"));
    });
  },
});

export default defineConfig({
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    poseidonConnection(),
  ],
});
