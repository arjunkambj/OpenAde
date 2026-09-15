// Flags the renderer as running inside the desktop shell; packages/ui styles and
// hooks key off these attributes.
function markDesktop(): boolean {
  const root = document.documentElement;
  if (!root) {
    return false;
  }

  root.setAttribute("data-desktop", "");
  if (process.platform === "darwin") {
    root.setAttribute("data-desktop-mac", "");
  }

  return true;
}

if (!markDesktop()) {
  window.addEventListener("DOMContentLoaded", markDesktop, { once: true });
}
