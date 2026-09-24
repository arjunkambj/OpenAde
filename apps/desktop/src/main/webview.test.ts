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
    });
  });

  it("attaches a blank tab the agent opened", () => {
    expect(applyWebviewAttachPolicy({}, electronParams({ src: "about:blank" }))).toBeNull();
  });

  /**
   * Electron derives `plugins` and `disablePopups` into `webPreferences`
   * *before* the event fires and builds the guest from that object, so only
   * the preferences the policy writes can still deny a capability.
   */
  it("permits popups but still pins plugins off in the derived preferences", () => {
    const params = electronParams({ allowpopups: true, plugins: true });
    const preferences: GuestPreferences = {
      disablePopups: false,
      plugins: true,
      nodeIntegration: true,
      sandbox: false,
      webviewTag: true,
    };

    expect(applyWebviewAttachPolicy(preferences, params)).toBeNull();
    expect(preferences.disablePopups).toBe(false);
    expect(params["allowpopups"]).toBe(true);
    expect(preferences).toMatchObject({
      plugins: false,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it("pins plugins off on a refused attach too", () => {
    const preferences: GuestPreferences = { plugins: true };

    expect(
      applyWebviewAttachPolicy(preferences, electronParams({ src: "file:///etc/passwd" })),
    ).not.toBeNull();
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
      plugins: true,
      webpreferences: "nodeIntegration=yes,contextIsolation=no",
    });

    expect(applyWebviewAttachPolicy({}, params)).toBeNull();
    expect(params["preload"]).toBe("");
    expect(params["webpreferences"]).toBe("");
    expect(params["nodeintegration"]).toBe(false);
    expect(params["plugins"]).toBe(false);
  });

  it("refuses a partition outside the pane's own namespace", () => {
    for (const partition of [
      "",
      "persist:other",
      "thread-1",
      "persist:thread-a/b",
      "persist:thread-",
      null,
    ]) {
      expect(applyWebviewAttachPolicy({}, electronParams({ partition }))).toMatch(/partition/);
    }
  });

  it("refuses a src that is not http(s) or a blank tab", () => {
    for (const src of [
      "",
      "file:///etc/passwd",
      "poseidon://app/",
      "javascript:alert(1)",
      "about:blank#x",
      "about:srcdoc",
      "data:text/html,hi",
      "chrome://gpu",
    ]) {
      expect(applyWebviewAttachPolicy({}, electronParams({ src }))).toMatch(/src/);
    }
  });
});
