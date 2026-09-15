import { spawn } from "node:child_process";

import electronPath from "electron";
import * as esbuild from "esbuild";

import { bundleOptions, root } from "./build.mjs";

const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:3001";

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
let restarting = false;
/** @type {NodeJS.Timeout | null} */
let restartTimer = null;

function startElectron() {
  child = spawn(electronPath, [root], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development", ELECTRON_RENDERER_URL: devServerUrl },
  });

  child.on("exit", (code) => {
    child = null;
    if (!restarting) {
      process.exit(code ?? 0);
    }
  });
}

function scheduleRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!child) {
      startElectron();
      return;
    }

    restarting = true;
    child.once("exit", () => {
      restarting = false;
      startElectron();
    });
    child.kill();
  }, 100);
}

let started = false;

const restartPlugin = {
  name: "restart-electron",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        return;
      }

      if (!started) {
        return;
      }

      scheduleRestart();
    });
  },
};

const contexts = await Promise.all(
  bundleOptions({ watch: true }).map((options) =>
    esbuild.context({ ...options, plugins: [restartPlugin] }),
  ),
);

await Promise.all(contexts.map((context) => context.watch()));

started = true;
startElectron();

function shutdown() {
  restarting = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  child?.kill();
  void Promise.all(contexts.map((context) => context.dispose())).then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
