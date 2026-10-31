import { useEffect } from "react";
import { measurePopoverContentSize } from "./popover-content-height";

type Size = { width: number; height: number };

// Keeps the host window sized to the shell's content: reports the measured size to
// main whenever the shell, an open overlay, or the layout canvas changes. The tray
// popover and pinned desktop widgets share this, differing only in how they measure.
export function usePopoverContentSize(measure: (shell: HTMLElement) => Size = measurePopoverContentSize) {
  useEffect(() => {
    const element = document.querySelector<HTMLElement>(".app-shell");
    if (!element || !window.babyMenu?.popover) return undefined;

    let animationFrame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    const report = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        const { width, height } = measure(element);
        if (!height || (width === lastWidth && height === lastHeight)) return;
        lastWidth = width;
        lastHeight = height;
        void window.babyMenu?.popover.setContentSize({ width, height });
      });
    };

    report();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    resizeObserver?.observe(element);

    // Overlays (Dialog/Select/Dropdown) portal outside .app-shell, so watch the
    // body subtree to react when one opens or closes. Also observe the overlay
    // itself: a tall overlay can be max-h-clamped while the window is small, then
    // expand once the window grows, so we need to re-measure until it settles.
    // Observe the overlay and the layout canvas directly. The shell width is
    // 100% of the window, so a custom layout that changes only its own width (the
    // canvas overflows the shell) does not resize .app-shell and would otherwise
    // be missed; observing the canvas catches it so the window keeps adapting.
    const observed = new Map<string, Element>();
    const syncExtraObservations = () => {
      for (const selector of ["[data-bm-overlay]", "[data-bm-canvas]"]) {
        const next = document.querySelector(selector);
        const current = observed.get(selector) ?? null;
        if (next === current) continue;
        if (current) resizeObserver?.unobserve(current);
        if (next) {
          observed.set(selector, next);
          resizeObserver?.observe(next);
        } else {
          observed.delete(selector);
        }
      }
    };
    syncExtraObservations();
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            syncExtraObservations();
            report();
          });
    mutationObserver?.observe(document.body, { childList: true, subtree: true });

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [measure]);
}
