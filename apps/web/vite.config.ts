import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const DEV_CONNECTION_PATH = join(homedir(), ".openade", "dev", "connection.json");

/**
 * Serves `~/.openade/dev/connection.json` at `/__openade/connection` so a
 * browser renderer can find a dev-mode server without Electron. Dev-only —
 * the production build embeds the desktop's preload channel instead.
 */
const openadeConnection = (): Plugin => ({
  name: "openade-connection",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__openade/connection", (_req, res) => {
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
    port: 3001,
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
    openadeConnection(),
  ],
});
