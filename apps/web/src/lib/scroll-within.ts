/**
 * Scrolls one scroller so a child of it comes into view, moving nothing else.
 *
 * `Element.scrollIntoView` scrolls every clipping ancestor as well as the
 * nearest scroller. The right dock is one while it animates open — it clips
 * its content and animates its width or translate — so a reveal that runs as
 * the dock opens (a Changes link, a timeline file chip) would shift the dock
 * sideways. Moving only the scroller's own `scrollTop` keeps it put.
 *
 * `start` puts the target's top at the scroller's top; `center` centres the
 * target in the scroller's visible height.
 */
export type ScrollAlign = "start" | "center";

export interface ScrollBox {
  scrollTop: number;
  readonly clientHeight: number;
  getBoundingClientRect(): { readonly top: number };
}

export interface ScrollTarget {
  getBoundingClientRect(): { readonly top: number; readonly height: number };
}

export const scrollWithin = (
  scroller: ScrollBox,
  target: ScrollTarget | undefined,
  align: ScrollAlign = "start",
): void => {
  if (target === undefined) {
    return;
  }
  const rect = target.getBoundingClientRect();
  const offset = rect.top - scroller.getBoundingClientRect().top;
  scroller.scrollTop +=
    align === "center" ? offset - (scroller.clientHeight - rect.height) / 2 : offset;
};
