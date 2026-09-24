/**
 * The Electron main process `record-agent-browser.mjs` records through.
 *
 * It is a window of pane-style `<webview>` guests (one `persist:thread-<id>`
 * partition per thread) with the real browser bridge from
 * `src/main/browser/server.ts` in front of them, and a `GuestPort` built on
 * each guest's `webContents.debugger` — the smallest Electron side that lets
 * the real agent-browser drive real guests through the real bridge. It is
 * not the app's port and nothing in the app imports it; it exists so the
 * recordings under `packages/testkit/fixtures/agent-browser/` are captures
 * of real runs rather than hand-written frames.
 *
 * The recorder bundles this file with esbuild (so the TypeScript bridge
 * loads under Electron) and talks to it over stdio, one JSON object per line:
 *
 *   stdin  {seq, op: "setup", threadId, tabs: [url]}   → {seq, guests}
 *   stdin  {seq, op: "eval", threadId, index, js}      → {seq, value}
 *   stdin  {seq, op: "guests", threadId}               → {seq, guests}
 *   stdin  {seq, op: "remove", threadId, index}        → {seq, guests}  (the pane closing a tab)
 *   stdin  {seq, op: "quit"}
 *   stdout {type: "ready", origin, launchKey}
 *   stdout {type: "frame", threadId, connection, direction, message, at}
 *   stdout {type: "log", entry}      the bridge's own log: connections, refusals
 */

import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { app, BrowserWindow, session } from "electron";

import { mintLaunchKey } from "@OpenAde/shared/browserBridge";

import { startBridgeServer } from "../src/main/browser/server.ts";

const OUT = process.env.OPENADE_RECORD_HOST_DIR ?? app.getPath("temp");
app.setPath("userData", NodePath.join(OUT, "userData"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const started = Date.now();

/** wcId → { wc, threadId, targetId } for every registered guest. */
const guests = new Map();
const listeners = new Set();
const pendingThreads = new Set();
let win = null;
let tabCounter = 0;

const emit = (event) => {
  for (const listener of listeners) listener(event);
};

const threadOf = (wc) => {
  for (const threadId of pendingThreads) {
    if (wc.session === session.fromPartition(`persist:thread-${threadId}`)) return threadId;
  }
  return null;
};

const infoOf = (entry) => ({
  wcId: entry.wc.id,
  targetId: entry.targetId,
  url: entry.wc.getURL(),
  title: entry.wc.getTitle(),
});

const register = async (wc) => {
  const threadId = threadOf(wc);
  if (threadId === null) {
    process.stderr.write(`guest ${wc.id} belongs to no recorded thread\n`);
    return;
  }
  wc.debugger.attach("1.3");
  const { targetInfo } = await wc.debugger.sendCommand("Target.getTargetInfo");
  const entry = { wc, threadId, targetId: targetInfo.targetId };
  guests.set(wc.id, entry);
  wc.debugger.on("message", (_event, method, params, sessionId) => {
    if (sessionId) emit({ type: "cdp", wcId: wc.id, method, params, sessionId });
  });
  const changed = () => {
    if (guests.has(wc.id)) emit({ type: "changed", threadId, guest: infoOf(entry) });
  };
  wc.on("page-title-updated", changed);
  wc.on("did-navigate", changed);
  wc.on("did-navigate-in-page", changed);
  wc.once("destroyed", () => {
    guests.delete(wc.id);
    emit({ type: "destroyed", threadId, wcId: entry.wc.id, targetId: entry.targetId });
  });
  emit({ type: "created", threadId, guest: infoOf(entry) });
};

const hostEval = (js) => win.webContents.executeJavaScript(js);

const guestsOf = (threadId) =>
  [...guests.values()].filter((entry) => entry.threadId === threadId).map(infoOf);

/** Adds a `<webview>` for the thread and resolves once it is a registered guest. */
const createTab = async (threadId, url) => {
  pendingThreads.add(threadId);
  const before = new Set(guests.keys());
  const id = `tab-${++tabCounter}`;
  // Listen before the element exists: the guest can register before the
  // host's executeJavaScript even resolves.
  const registered = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      unsubscribe();
      reject(new Error(`tab ${id} did not become a target`));
    }, 10_000);
    const unsubscribe = port.onEvent((event) => {
      if (
        event.type === "created" &&
        event.threadId === threadId &&
        !before.has(event.guest.wcId)
      ) {
        clearTimeout(deadline);
        unsubscribe();
        resolve(event.guest);
      }
    });
  });
  await hostEval(`(() => {
    const view = document.createElement("webview");
    view.id = ${JSON.stringify(id)};
    view.setAttribute("partition", ${JSON.stringify(`persist:thread-${threadId}`)});
    view.setAttribute("allowpopups", "");
    view.setAttribute("src", ${JSON.stringify(url)});
    document.getElementById("tabs").appendChild(view);
  })()`);
  return registered;
};

/** @type {import("../src/main/browser/bridgeSession.ts").GuestPort} */
const port = {
  guestsOf,
  send: (wcId, method, params, sessionId) =>
    guests.get(wcId).wc.debugger.sendCommand(method, params, sessionId),
  attachChild: async (wcId) => {
    const entry = guests.get(wcId);
    const { sessionId } = await entry.wc.debugger.sendCommand("Target.attachToTarget", {
      targetId: entry.targetId,
      flatten: true,
    });
    return sessionId;
  },
  detachChild: async (wcId, sessionId) => {
    const entry = guests.get(wcId);
    if (entry !== undefined && !entry.wc.isDestroyed()) {
      await entry.wc.debugger.sendCommand("Target.detachFromTarget", { sessionId });
    }
  },
  onEvent: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  reload: async (wcId, ignoreCache) => {
    const { wc } = guests.get(wcId);
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
  },
  createTab,
  closeTab: async (wcId) => {
    await hostEval(`(() => {
      const view = [...document.querySelectorAll("webview")]
        .find((candidate) => candidate.getWebContentsId() === ${Number(wcId)});
      view?.remove();
    })()`);
  },
  // The recording window stacks every tab; bringing one forward is a no-op.
  selectTab: async () => undefined,
  // Focus the guest's element for the one command, then hand focus back.
  withFocus: async (wcId, operation) => {
    const key = JSON.stringify(`recordFocus${wcId}`);
    await hostEval(`(() => {
      const view = [...document.querySelectorAll("webview")]
        .find((candidate) => candidate.getWebContentsId() === ${Number(wcId)});
      const previous = document.activeElement;
      globalThis[${key}] = () => {
        if (previous && previous.isConnected && previous !== view) previous.focus({ preventScroll: true });
      };
      view?.focus();
    })()`);
    try {
      return await operation();
    } finally {
      await hostEval(`globalThis[${key}]?.()`).catch(() => undefined);
    }
  },
};

app.on("web-contents-created", (_event, wc) => {
  if (wc.getType() !== "webview") return;
  wc.setWindowOpenHandler(({ url }) => {
    const threadId = threadOf(wc);
    if (threadId !== null) void createTab(threadId, url).catch(() => undefined);
    return { action: "deny" };
  });
  wc.once(
    "did-attach",
    () => void register(wc).catch((error) => process.stderr.write(`register failed: ${error}\n`)),
  );
});

const handle = async (request) => {
  switch (request.op) {
    case "setup": {
      pendingThreads.add(request.threadId);
      for (const url of request.tabs) {
        const guest = await createTab(request.threadId, url);
        const { wc } = guests.get(guest.wcId);
        if (wc.isLoading()) await new Promise((resolve) => wc.once("did-stop-loading", resolve));
      }
      return { guests: guestsOf(request.threadId) };
    }
    case "eval": {
      const guest = guestsOf(request.threadId)[request.index];
      return { value: await guests.get(guest.wcId).wc.executeJavaScript(request.js) };
    }
    case "guests":
      return { guests: guestsOf(request.threadId) };
    case "remove": {
      const guest = guestsOf(request.threadId)[request.index];
      const destroyed = new Promise((resolve) =>
        guests.get(guest.wcId).wc.once("destroyed", resolve),
      );
      await port.closeTab(guest.wcId);
      await destroyed;
      return { guests: guestsOf(request.threadId) };
    }
    case "quit":
      setTimeout(() => app.quit(), 50);
      return {};
    default:
      throw new Error(`unknown op ${request.op}`);
  }
};

app.whenReady().then(async () => {
  const launchKey = mintLaunchKey();
  const bridge = await startBridgeServer({
    launchKey,
    port,
    version: {
      protocolVersion: "1.3",
      product: `Chrome/${process.versions.chrome}`,
      revision: "",
      userAgent: app.userAgentFallback,
      jsVersion: process.versions.v8,
    },
    log: (entry) => write({ type: "log", entry }),
    onFrame: ({ threadId, connection, direction, message }) =>
      write({ type: "frame", threadId, connection, direction, message, at: Date.now() - started }),
  });
  const hostFile = NodePath.join(OUT, "host.html");
  NodeFs.writeFileSync(
    hostFile,
    `<!doctype html><html><head><meta charset="utf-8"><title>Recording host</title>
<style>body{margin:0}#tabs{position:relative;width:1000px;height:700px}
webview{position:absolute;inset:0;width:1000px;height:700px}</style></head>
<body><div id="tabs"></div></body></html>`,
  );
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  await win.loadFile(hostFile);
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    handle(request).then(
      (result) => write({ type: "result", seq: request.seq, ...result }),
      (error) =>
        write({ type: "result", seq: request.seq, error: String(error?.message ?? error) }),
    );
  });
  app.on("will-quit", () => void bridge.close());
  write({ type: "ready", origin: bridge.origin, launchKey });
});

app.on("window-all-closed", () => app.quit());
