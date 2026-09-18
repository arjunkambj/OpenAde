/**
 * Window creation, persisted geometry, the `webviewTag` partition guard for
 * the browser pane, and the external-link and navigation policies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow, app, screen, shell } from "electron";

import { decideNavigation } from "./navigation";
import { APP_URL } from "./protocol";
import { titleBarStyle } from "../platform";
import { applyWebviewAttachPolicy } from "./webview";
import {
  captureWindowState,
  clampToDisplays,
  parseWindowState,
  type WindowState,
} from "./windowState";

const MIN_WINDOW_WIDTH = 256;
const MIN_WINDOW_HEIGHT = 248;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;

const statePath = () => join(app.getPath("userData"), "window-state.json");

/** Geometry settles in bursts; one write per burst is enough. */
const SAVE_DEBOUNCE_MS = 500;

const loadWindowState = (): WindowState => {
  let raw = "";
  try {
    raw = readFileSync(statePath(), "utf8");
  } catch {
    // first run, or the file was removed
  }
  return clampToDisplays(
    parseWindowState(raw),
    screen.getAllDisplays().map((display) => display.workArea),
  );
};

const saveWindowState = (win: BrowserWindow) => {
  // A minimized window reports neither its real rect nor its real flags.
  if (win.isDestroyed() || win.isMinimized()) return;
  try {
    writeFileSync(statePath(), JSON.stringify(captureWindowState(win)));
  } catch {
    // best-effort persistence
  }
};

/**
 * Persist on every geometry change, debounced, and once more on close: bound
 * to `close` alone, a crash or a force-quit persisted nothing at all.
 */
const trackWindowState = (win: BrowserWindow) => {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveWindowState(win);
    }, SAVE_DEBOUNCE_MS);
    timer.unref();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("enter-full-screen", schedule);
  win.on("leave-full-screen", schedule);
  win.on("close", () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    saveWindowState(win);
  });
};

/**
 * The window's own WebContents never leaves the renderer's origin: a link in
 * model-authored markdown, or a url dropped onto the window, would otherwise
 * load a remote page *with the preload attached* and hand it the RPC token —
 * see `./navigation`. Guests in the browser pane are separate WebContents and
 * are not affected; they navigate freely.
 */
const guardNavigation = (contents: Electron.WebContents) => {
  const decide = (event: Electron.Event, url: string) => {
    const decision = decideNavigation(url, {
      appUrl: APP_URL,
      devServerUrl: DEV_SERVER_URL,
    });
    if (decision.kind === "allow") return;
    event.preventDefault();
    if (decision.kind === "external") {
      void shell.openExternal(decision.url);
      return;
    }
    console.warn(`[navigation] refused: ${decision.reason}`);
  };
  contents.on("will-navigate", decide);
  // Subframes carry no preload, but an off-origin frame has no business here
  // either, and this is the only event a `<iframe>` navigation emits.
  contents.on("will-frame-navigate", (details) => decide(details, details.url));
};

/**
 * Only the browser pane's `persist:thread-<id>` partitions may attach, and
 * every guest runs with preferences this side pins — see `./webview`.
 */
const guardWebviewAttach = (contents: Electron.WebContents) => {
  contents.on("will-attach-webview", (event, preferences, params) => {
    const refusal = applyWebviewAttachPolicy(preferences, params);
    if (refusal !== null) {
      console.warn(`[webview] refused attach: ${refusal}`);
      event.preventDefault();
    }
  });
};

const waitForDevServer = async (url: string): Promise<boolean> => {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
};

export async function createWindow(): Promise<BrowserWindow> {
  const { maximized, fullScreen, ...bounds } = loadWindowState();
  const win = new BrowserWindow({
    title: "OpenAde",
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    fullscreen: fullScreen,
    show: false,
    titleBarStyle: titleBarStyle(),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  if (maximized && !fullScreen) win.maximize();

  win.once("ready-to-show", () => win.show());
  trackWindowState(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  guardNavigation(win.webContents);
  guardWebviewAttach(win.webContents);

  const target =
    DEV_SERVER_URL !== undefined && (await waitForDevServer(DEV_SERVER_URL))
      ? DEV_SERVER_URL
      : APP_URL;
  await win.loadURL(target);
  return win;
}
