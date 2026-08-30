import { BrowserWindow, Updater } from "electrobun/main";

const DEV_SERVER_URL = "http://localhost:3001";

async function getMainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) !== "dev") {
    return "views://mainview/index.html";
  }

  for (let i = 0; i < 120; i++) {
    try {
      await fetch(DEV_SERVER_URL);
      return DEV_SERVER_URL;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return "views://mainview/index.html";
}

new BrowserWindow({
  title: "OpenAde",
  url: await getMainViewUrl(),
  renderer: "cef",
  titleBarStyle: "hiddenInset",
  preload: `document.documentElement.setAttribute("data-desktop","");
if (navigator.userAgent.includes("Mac")) {
  document.documentElement.setAttribute("data-desktop-mac","");
}`,
  frame: {
    width: 1280,
    height: 820,
    x: 120,
    y: 120,
  },
});
