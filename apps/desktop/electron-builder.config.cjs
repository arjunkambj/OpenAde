const channel = process.env.BUILD_CHANNEL === "canary" ? "canary" : "stable";
const isCanary = channel === "canary";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  // Must stay equal to the id `src/platform` passes to `setAppUserModelId`,
  // or Windows splits taskbar grouping and notifications from the install.
  appId: isCanary ? "dev.openade.OpenAde.desktop.canary" : "dev.openade.OpenAde.desktop",
  productName: isCanary ? "OpenAde Canary" : "OpenAde",
  copyright: `Copyright © ${new Date().getFullYear()} OpenAde`,
  directories: {
    output: `artifacts/${channel}`,
    buildResources: "assets",
  },
  files: ["out/**/*", "package.json"],
  asar: true,
  // The server child process cannot spawn from inside the asar archive.
  asarUnpack: ["out/server/**"],
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
