import { existsSync } from "node:fs";
import type { ElectrobunConfig } from "electrobun";

const webBuildDir = "../web/dist";

export default {
  app: {
    name: "OpenAde",
    identifier: "dev.bettertstack.OpenAde.desktop",
    version: "0.0.1",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    mainProcess: "cottontail",
    cottontail: {
      entrypoint: "src/bun/index.ts",
    },
    copy: existsSync(webBuildDir) ? { [webBuildDir]: "views/mainview" } : {},
    watchIgnore: [`${webBuildDir}/**`],
    mac: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icons: "icon.iconset",
    },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icon: "assets/icon-1024.png",
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icon: "assets/icon-1024.png",
    },
  },
} satisfies ElectrobunConfig;
