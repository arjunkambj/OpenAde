import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { build, root } from "./build.mjs";

const args = process.argv.slice(2);
const channelIndex = args.findIndex((arg) => arg === "--channel");
const channel = channelIndex === -1 ? "stable" : (args[channelIndex + 1] ?? "stable");
const builderArgs =
  channelIndex === -1
    ? args
    : args.filter((_, index) => index !== channelIndex && index !== channelIndex + 1);

if (!["stable", "canary"].includes(channel)) {
  throw new Error(`Unknown channel "${channel}". Use "stable" or "canary".`);
}

// The bundle carries the channel too: the runtime names itself from it.
await build({ channel });

const require = createRequire(import.meta.url);
const builderBin = require.resolve("electron-builder/cli.js");

const child = spawn(
  process.execPath,
  [builderBin, "--config", join(root, "electron-builder.config.cjs"), ...builderArgs],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BUILD_CHANNEL: channel },
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
