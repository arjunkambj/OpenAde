/**
 * Window creation, persisted geometry, the `webviewTag` partition guard for
 * the browser pane, and the external-link policy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow, app, screen, shell } from "electron";

import { APP_URL } from "./protocol";
import { titleBarStyle } from "./platform";

const MIN_WINDOW_WIDTH = 256;
const MIN_WINDOW_HEIGHT = 248;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;

interface WindowState {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
}

const statePath = () => join(app.getPath("userData"), "window-state.json");

/** A restored position must keep this much of the window on some display. */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 48;

/**
 * Drop the persisted position when a monitor disconnect would leave the
 * window off-screen: the rect must overlap some display's work area by at
 * least the visible minimum, otherwise Electron re-centers it.
 */
const clampToDisplays = (state: WindowState): WindowState => {
  const { x, y, width, height } = state;
  if (x === undefined || y === undefined) return state;
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return overlapX >= MIN_VISIBLE_WIDTH && overlapY >= MIN_VISIBLE_HEIGHT;
  });
  return onScreen ? state : { width, height };
};

const loadWindowState = (): WindowState => {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as WindowState;
    return clampToDisplays({
      ...(typeof parsed.x === "number" ? { x: parsed.x } : {}),
      ...(typeof parsed.y === "number" ? { y: parsed.y } : {}),
      width: typeof parsed.width === "number" ? parsed.width : 1280,
      height: typeof parsed.height === "number" ? parsed.height : 820,
    });
  } catch {
    return { width: 1280, height: 820 };
  }
};

const saveWindowState = (win: BrowserWindow) => {
  if (win.isMinimized() || win.isFullScreen()) return;
  const bounds = win.getBounds();
  try {
    writeFileSync(statePath(), JSON.stringify(bounds));
  } catch {
    // best-effort persistence
  }
};

/**
 * Webview attributes that grant capabilities the browser pane never opts
 * into: `preload` runs a script with Node access, and `webpreferences`,
 * `nodeintegration` and `allowpopups` are escalation paths.
 */
const FORBIDDEN_WEBVIEW_PARAMS = [
  "webpreferences",
  "preload",
  "nodeintegration",
  "allowpopups",
] as const;

/**
 * Only `persist:thread-*` partitions may attach — the browser pane's channel —
 * and then only an http(s) `src` with none of the forbidden attributes.
 */
const guardWebviewAttach = (contents: Electron.WebContents) => {
  contents.on("will-attach-webview", (event, _preferences, params) => {
    const partition = params["partition"];
    const src = params["src"];
    const allowed =
      typeof partition === "string" &&
      partition.startsWith("persist:thread-") &&
      typeof src === "string" &&
      (src.startsWith("https://") || src.startsWith("http://")) &&
      FORBIDDEN_WEBVIEW_PARAMS.every((key) => !(key in params));
    if (!allowed) event.preventDefault();
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
  const state = loadWindowState();
  const win = new BrowserWindow({
    title: "OpenAde",
    ...state,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
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

  win.once("ready-to-show", () => win.show());
  win.on("close", () => saveWindowState(win));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  guardWebviewAttach(win.webContents);

  const target =
    DEV_SERVER_URL !== undefined && (await waitForDevServer(DEV_SERVER_URL))
      ? DEV_SERVER_URL
      : APP_URL;
  await win.loadURL(target);
  return win;
}
