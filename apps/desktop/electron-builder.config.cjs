const channel = process.env.BUILD_CHANNEL === "canary" ? "canary" : "stable";
const isCanary = channel === "canary";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: isCanary ? "dev.bettertstack.OpenAde.desktop.canary" : "dev.bettertstack.OpenAde.desktop",
  productName: isCanary ? "OpenAde Canary" : "OpenAde",
  copyright: `Copyright © ${new Date().getFullYear()} OpenAde`,
  directories: {
    output: `artifacts/${channel}`,
    buildResources: "assets",
  },
  files: ["out/**/*", "package.json"],
  asar: true,
  npmRebuild: false,
  mac: {
    icon: "assets/AppIcon.icns",
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
  },
  win: {
    icon: "assets/icon-1024.png",
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
  },
  linux: {
    icon: "assets/icon-1024.png",
    category: "Development",
    target: ["AppImage", "deb"],
  },
};
