import { describe, expect, it } from "vitest";

import { applyWebviewAttachPolicy, type GuestPreferences } from "./webview";

/**
 * What Electron's renderer side actually sends: `buildParams()` walks a map
 * that is constructed with every attribute, so the keys are always present and
 * an attribute the tag never set arrives as `""` or `false`.
 */
const electronParams = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  instanceId: 1,
  partition: "persist:thread-01a0",
  src: "https://example.com/",
  httpreferrer: "",
  useragent: "",
  nodeintegration: false,
  nodeintegrationinsubframes: false,
  plugins: false,
  disablewebsecurity: false,
  allowpopups: false,
  preload: "",
  blinkfeatures: "",
  disableblinkfeatures: "",
  webpreferences: "",
  ...overrides,
});

describe("applyWebviewAttachPolicy", () => {
  it("allows a clean pane webview even though every attribute key is present", () => {
    const preferences: GuestPreferences = {};

    expect(applyWebviewAttachPolicy(preferences, electronParams())).toBeNull();
  });

  it("pins the guest's preferences on an allowed attach", () => {
    const preferences: GuestPreferences = {
      preload: "/tmp/evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      enableBlinkFeatures: "Whatever",
    };

    expect(applyWebviewAttachPolicy(preferences, electronParams())).toBeNull();
    expect(preferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      plugins: false,
      disablePopups: true,
    });
  });

  /**
   * Electron derives these two into `webPreferences` *before* the event fires
   * and builds the guest from that object, so the attributes are already spent:
   * only the preferences the policy writes can still deny the capability.
   */
  it("pins popups and plugins off in the preferences Electron already derived", () => {
    const params = electronParams({ allowpopups: true, plugins: true });
    const preferences: GuestPreferences = { disablePopups: false, plugins: true };

    expect(applyWebviewAttachPolicy(preferences, params)).toBeNull();
    expect(preferences.disablePopups).toBe(true);
    expect(preferences.plugins).toBe(false);
  });

  it("pins popups and plugins off on a refused attach too", () => {
    const preferences: GuestPreferences = { disablePopups: false, plugins: true };

    expect(
      applyWebviewAttachPolicy(preferences, electronParams({ src: "file:///etc/passwd" })),
    ).not.toBeNull();
    expect(preferences.disablePopups).toBe(true);
    expect(preferences.plugins).toBe(false);
  });

  it("pins the preferences on a refused attach too", () => {
    const preferences: GuestPreferences = { nodeIntegration: true, sandbox: false };

    expect(applyWebviewAttachPolicy(preferences, electronParams({ partition: "" }))).not.toBeNull();
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
  });

  it("resets renderer-supplied escalation attributes but still allows the attach", () => {
    const params = electronParams({
      preload: "file:///tmp/evil.js",
      nodeintegration: true,
      allowpopups: true,
      plugins: true,
      webpreferences: "nodeIntegration=yes,contextIsolation=no",
    });

    expect(applyWebviewAttachPolicy({}, params)).toBeNull();
    expect(params["preload"]).toBe("");
    expect(params["webpreferences"]).toBe("");
    expect(params["nodeintegration"]).toBe(false);
    expect(params["allowpopups"]).toBe(false);
    expect(params["plugins"]).toBe(false);
  });

  it("refuses a partition outside the pane's own namespace", () => {
    for (const partition of ["", "persist:other", "thread-1", "persist:thread-a/b", null]) {
      expect(applyWebviewAttachPolicy({}, electronParams({ partition }))).toMatch(/partition/);
    }
  });

  it("refuses a src that is not http(s)", () => {
    for (const src of ["", "file:///etc/passwd", "openade://app/", "javascript:alert(1)"]) {
      expect(applyWebviewAttachPolicy({}, electronParams({ src }))).toMatch(/src/);
    }
  });
});
