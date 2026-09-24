/**
 * Starts the browser bridge in the shell: a fresh launch key, the loopback
 * server in front of the pane guests, and what the server child is told.
 *
 * Any failure to start is reported as `disabled` — the desktop browser tools
 * then say the in-app browser is off rather than reaching for another browser.
 */
import { app } from "electron";

import { mintLaunchKey } from "@OpenAde/shared/browserBridge";

import type { BridgeForServer } from "../../backend/serverEnv";
import type { GuestPort } from "./bridgeSession";
import { startBridgeServer, type BridgeServer } from "./server";

export interface StartedBridge {
  readonly forServer: BridgeForServer;
  readonly server: BridgeServer | null;
}

export const startPaneBridge = async (port: GuestPort): Promise<StartedBridge> => {
  const launchKey = mintLaunchKey();
  try {
    const server = await startBridgeServer({
      launchKey,
      port,
      version: {
        protocolVersion: "1.3",
        product: `Chrome/${process.versions.chrome}`,
        revision: "",
        userAgent: app.userAgentFallback,
        jsVersion: process.versions.v8,
      },
      // Refusal reasons never carry the capability (`./upgradeGate`).
      log: (entry) => console.info(`[browser-bridge] ${JSON.stringify(entry)}`),
    });
    return { forServer: { kind: "enabled", origin: server.origin, launchKey }, server };
  } catch (error) {
    console.error(`[browser-bridge] did not start: ${String(error)}`);
    return { forServer: { kind: "disabled" }, server: null };
  }
};
