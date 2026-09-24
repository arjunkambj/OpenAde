/**
 * ipcMain handlers backing the preload bridge: connection info, server-state
 * fan-out, validated external opens, directory picking, and the browser pane's
 * guests.
 *
 * Every pane webview guest is set up once, the moment it is created
 * (`web-contents-created`), never again on a remount:
 * - its `window.open` handler, which always denies the native window and
 *   turns an http(s) popup into a pane tab of the same thread;
 * - the human-input relay (`./browser/guestInput.ts`), tagged with the
 *   guest's thread and `webContents` id;
 * - the bridge registry (`./browser/guests.ts`), which attaches its debugger
 *   when the bridge is running.
 * The window answers tab requests (`./browser/tabsChannel.ts`) on its own
 * channel, and asks for a deleted thread's partition to be cleared
 * (`./browser/clearThread.ts`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import type { WebContents } from "electron";

import type { ServerSupervisor } from "../backend/ServerSupervisor";

import { makeClearThread } from "./browser/clearThread";
import { makeGuestInputRelay } from "./browser/guestInput";
import { popupUrl, type GuestRegistry } from "./browser/guests";
import { CLEAR_THREAD_CHANNEL, TAB_ANSWER_CHANNEL, type TabsChannel } from "./browser/tabsChannel";
import { registerServerStateBridge } from "./serverStateBridge";

/** The browser pane's main-process side, built in `./index.ts`. */
export interface PaneGuests {
  readonly guests: GuestRegistry;
  readonly tabs: TabsChannel;
}

export function registerIpc(supervisor: ServerSupervisor, pane: PaneGuests) {
  // `openade:connection`, `openade:server-state:get` and the push channel —
  // the seam the renderer reconnects against, in its own testable module.
  registerServerStateBridge(
    {
      handle: (channel, handler) => ipcMain.handle(channel, handler),
      senders: () => BrowserWindow.getAllWindows().map((win) => win.webContents),
    },
    supervisor,
  );
  ipcMain.handle("openade:open-external", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("openade:pick-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // ── browser pane guests ────────────────────────────────────────

  ipcMain.handle(TAB_ANSWER_CHANNEL, (event, payload: unknown) => {
    pane.tabs.answer(event.sender.id, payload);
  });
  // Electron keeps `persist:<name>` under `<sessionData>/Partitions/<name>`.
  const clearThread = makeClearThread({
    partitionExists: (threadId) =>
      existsSync(join(app.getPath("sessionData"), "Partitions", `thread-${threadId}`)),
    fromPartition: (partition) => session.fromPartition(partition),
  });
  ipcMain.handle(CLEAR_THREAD_CHANNEL, async (_event, threadId: unknown) => {
    await clearThread(threadId);
  });
  app.on("browser-window-created", (_event, win) => {
    const id = win.webContents.id;
    win.webContents.once("destroyed", () => pane.tabs.abandon(id));
  });

  const relay = makeGuestInputRelay();

  const setUpGuest = (guest: WebContents) => {
    const wcId = guest.id;
    // Before anything else: a popup must never become a native window.
    guest.setWindowOpenHandler(({ url }) => {
      const threadId = pane.guests.threadOf(wcId);
      const target = popupUrl(url);
      if (threadId !== null && target !== null) {
        pane.tabs.create(threadId, target, false, wcId).catch((error: unknown) => {
          console.warn(`[browser] popup dropped: ${String(error)}`);
        });
      }
      return { action: "deny" };
    });
    const threadId = pane.guests.track(guest);
    if (threadId === null) return;
    relay.hook(
      {
        id: wcId,
        onKey: (listener) => guest.on("before-input-event", (_event, input) => listener(input)),
        onMouse: (listener) => guest.on("before-mouse-event", (_event, mouse) => listener(mouse)),
        host: () => guest.hostWebContents,
      },
      threadId,
    );
    guest.once("destroyed", () => relay.forget(wcId));
  };

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") setUpGuest(contents);
  });
}
