"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Keeps the current Review tab in view. The tabs fit a 320px phone, but where the strip still has to scroll (a
 * narrower screen, or text enlarged by the reader) the page would otherwise open on a cut-off tab; its scrollbar is
 * hidden, so nothing would hint at it. Each tab is its own page, so this runs whenever another tab opens.
 */
export function ReviewTabStrip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = ref.current?.querySelector<HTMLElement>(".tabs-list");
    const tab = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    const box = list.getBoundingClientRect();
    const current = tab.getBoundingClientRect();
    if (current.right > box.right) list.scrollLeft += current.right - box.right;
    else if (current.left < box.left) list.scrollLeft -= box.left - current.left;
  }, []);
  return <div ref={ref}>{children}</div>;
}
