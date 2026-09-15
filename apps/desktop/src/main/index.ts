import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, app, net, protocol, shell } from "electron";

const APP_SCHEME = "app";
const APP_URL = `${APP_SCHEME}://openade/`;
// Set by scripts/dev.mjs; when absent the app serves the bundled build.
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;
const RENDERER_ROOT = normalize(join(__dirname, "..", "renderer"));
const MIN_WINDOW_WIDTH = 256;
const MIN_WINDOW_HEIGHT = 248;

// Keeps app paths (userData, cache) tied to the product rather than the package name.
app.setName("OpenAde");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

function resolveRendererFile(pathname: string): string | null {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = normalize(join(RENDERER_ROOT, relative));
  if (candidate !== RENDERER_ROOT && !candidate.startsWith(RENDERER_ROOT + sep)) {
    return null;
  }

  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

function registerAppProtocol() {
  // Serve the built web app over a custom scheme so the history-based router
  // keeps working; unknown paths fall back to index.html like an SPA host.
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const file = resolveRendererFile(pathname) ?? join(RENDERER_ROOT, "index.html");
    return net.fetch(pathToFileURL(file).toString());
  });
}

async function getMainViewUrl(): Promise<string> {
  if (!DEV_SERVER_URL) {
    return APP_URL;
  }

  for (let i = 0; i < 120; i++) {
    try {
      await fetch(DEV_SERVER_URL);
      return DEV_SERVER_URL;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return APP_URL;
}

async function createWindow() {
  const win = new BrowserWindow({
    title: "OpenAde",
    width: 1280,
    height: 820,
    x: 120,
    y: 120,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(await getMainViewUrl());

  return win;
}

function focusExistingWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusExistingWindow);

  app.whenReady().then(async () => {
    app.setAppUserModelId("dev.bettertstack.OpenAde.desktop");
    registerAppProtocol();
    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  });

  // Matches the previous shell's exitOnLastWindowClosed behaviour on every platform.
  app.on("window-all-closed", () => app.quit());
}
