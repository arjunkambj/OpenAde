/**
 * The sidebar's right edge: drag it to resize, click it to toggle — the same
 * edge the rail used to be, so the click that folded the sidebar still does.
 *
 * A press only becomes a drag once the pointer has moved a few pixels; below
 * that it is a click. While dragging, the wrapper carries `data-resizing`, which
 * switches off the sidebar's width transition so the edge tracks the pointer
 * instead of easing after it.
 */

import * as React from "react";

import { useSidebar } from "@OpenAde/ui/components/sidebar";

import { useSidebarWidth } from "@/state/ui";

const DRAG_THRESHOLD_PX = 3;

export function SidebarResizeHandle() {
  const { toggleSidebar } = useSidebar();
  const [width, setWidth] = useSidebarWidth();

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const wrapper = event.currentTarget.closest<HTMLElement>("[data-slot=sidebar-wrapper]");
      const startX = event.clientX;
      const startWidth = width;
      let dragging = false;

      const onMove = (move: PointerEvent) => {
        const delta = move.clientX - startX;
        if (!dragging && Math.abs(delta) < DRAG_THRESHOLD_PX) {
          return;
        }
        if (!dragging) {
          dragging = true;
          wrapper?.setAttribute("data-resizing", "true");
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }
        setWidth(startWidth + delta);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        wrapper?.removeAttribute("data-resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (!dragging) {
          toggleSidebar();
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth, toggleSidebar],
  );

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label="Resize sidebar"
      title="Drag to resize, click to toggle"
      onPointerDown={onPointerDown}
      className="absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:transition-colors after:duration-150 hover:after:bg-sidebar-border sm:flex"
    />
  );
}
