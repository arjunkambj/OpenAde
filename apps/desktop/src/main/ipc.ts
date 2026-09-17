/**
 * ipcMain handlers backing the preload bridge: connection info, server-state
 * fan-out, validated external opens, directory picking, and the browser-pane
 * guest bridge (W6 mode A).
 *
 * The pane's `<webview>` runs in a `persist:thread-*` partition. `attach`
 * records the thread and its host webContents; when the guest webContents
 * appears (`web-contents-created`) we hook `before-input-event` and
 * `before-mouse-event` on it — the ONLY place guest input is observable —
 * and relay it back to the host, which forwards it as `browser.humanInput`.
 * The server decides whether the input is human or the agent's own
 * automation echo via the in-flight lease, so this relay reports everything.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell, webContents } from "electron";
import type { WebContents } from "electron";

import type { ServerSupervisor, ServerState } from "../backend/ServerSupervisor";

/** One gesture from inside a pane webview, already contract-shaped. */
export type GuestInput =
  | { readonly kind: "click"; readonly x: number; readonly y: number; readonly button?: string }
  | {
      readonly kind: "key";
      readonly key: string;
      readonly modifiers?: ReadonlyArray<"alt" | "ctrl" | "meta" | "shift">;
    }
  | { readonly kind: "scroll"; readonly deltaX: number; readonly deltaY: number };

const THREAD_ID = /^[A-Za-z0-9_-]+$/;

export function registerIpc(supervisor: ServerSupervisor) {
  ipcMain.handle("openade:connection", () => supervisor.connection);
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

  // ── browser pane guest bridge ──────────────────────────────────

  /** Threads whose pane is mounted but whose guest has not appeared yet. */
  const pending = new Map<string, WebContents>();
  /** Hooked guests, keyed by threadId for detach. */
  const attached = new Map<string, { guest: WebContents; host: WebContents }>();

  const partitionFor = (threadId: string) => session.fromPartition(`persist:thread-${threadId}`);

  const relay = (threadId: string, host: WebContents, input: GuestInput) => {
    if (!host.isDestroyed()) {
      host.send("openade:browser-input", { threadId, input });
    }
  };

  const hookGuest = (threadId: string, guest: WebContents, host: WebContents) => {
    guest.on("before-input-event", (_event, input) => {
      // keyDown only — char/rawKeyDown/keyUp would double-report.
      if (input.type !== "keyDown") return;
      const modifiers: Array<"alt" | "ctrl" | "meta" | "shift"> = [];
      for (const m of input.modifiers ?? []) {
        if (m === "alt") modifiers.push("alt");
        else if (m === "control" || m === "ctrl") modifiers.push("ctrl");
        else if (m === "meta" || m === "cmd" || m === "command") modifiers.push("meta");
        else if (m === "shift") modifiers.push("shift");
      }
      relay(threadId, host, {
        kind: "key",
        key: input.key ?? "",
        ...(modifiers.length > 0 ? { modifiers } : {}),
      });
    });
    guest.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown" || mouse.type === "contextMenu") {
        relay(threadId, host, {
          kind: "click",
          x: mouse.x,
          y: mouse.y,
          ...(mouse.button === undefined ? {} : { button: mouse.button }),
        });
      } else if (mouse.type === "mouseWheel") {
        const wheel = mouse as Electron.MouseWheelInputEvent;
        relay(threadId, host, {
          kind: "scroll",
          deltaX: wheel.deltaX ?? 0,
          deltaY: wheel.deltaY ?? 0,
        });
      }
    });
    guest.once("destroyed", () => attached.delete(threadId));
    attached.set(threadId, { guest, host });
  };

  /** Try to bind a pending thread to its guest right now. */
  const tryAttach = (threadId: string) => {
    if (attached.has(threadId)) return;
    const host = pending.get(threadId);
    if (host === undefined || host.isDestroyed()) {
      pending.delete(threadId);
      return;
    }
    const ses = partitionFor(threadId);
    const guest = webContents
      .getAllWebContents()
      .find(
        (candidate) =>
          candidate.getType() === "webview" &&
          candidate.session === ses &&
          !candidate.isDestroyed(),
      );
    if (guest !== undefined) {
      pending.delete(threadId);
      hookGuest(threadId, guest, host);
    }
  };

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    for (const threadId of pending.keys()) {
      tryAttach(threadId);
    }
  });

  ipcMain.handle("openade:browser-attach", (event, threadId: unknown) => {
    if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) return;
    pending.set(threadId, event.sender);
    tryAttach(threadId);
  });

  ipcMain.handle("openade:browser-detach", (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) return;
    pending.delete(threadId);
    // The guest keeps its listeners but the host pointer is dropped, so a
    // remount can't double-report; listeners die with the guest.
    attached.delete(threadId);
  });

  supervisor.on("state", (state: ServerState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("openade:server-state", state);
    }
  });
}
