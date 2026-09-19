import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { appUserModelId, productName, resolveChannel } from "./channel";

const require = createRequire(import.meta.url);
/** The packaged identity, read from the very config electron-builder is given. */
const builderConfig = (channel: string): { appId: string; productName: string } => {
  const previous = process.env["BUILD_CHANNEL"];
  process.env["BUILD_CHANNEL"] = channel;
  delete require.cache[require.resolve("../../electron-builder.config.cjs")];
  try {
    return require("../../electron-builder.config.cjs") as { appId: string; productName: string };
  } finally {
    if (previous === undefined) delete process.env["BUILD_CHANNEL"];
    else process.env["BUILD_CHANNEL"] = previous;
  }
};

describe("resolveChannel", () => {
  it("treats anything but the canary marker as stable", () => {
    expect(resolveChannel("canary")).toBe("canary");
    for (const raw of [undefined, "", "stable", "Canary", "nightly"]) {
      expect(resolveChannel(raw)).toBe("stable");
    }
  });
});

describe("the runtime identity", () => {
  it("matches what electron-builder packages, per channel", () => {
    for (const channel of ["stable", "canary"] as const) {
      const packaged = builderConfig(channel);
      expect(productName(channel)).toBe(packaged.productName);
      expect(appUserModelId(channel)).toBe(packaged.appId);
    }
  });

  it("keeps the two channels apart", () => {
    expect(productName("canary")).not.toBe(productName("stable"));
    expect(appUserModelId("canary")).not.toBe(appUserModelId("stable"));
  });
});
