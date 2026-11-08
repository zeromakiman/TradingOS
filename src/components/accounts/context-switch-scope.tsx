"use client";

import type { MouseEvent, ReactNode } from "react";

/**
 * The address to load in full for a link that switches the trading-account context (`?account=all|<id>`, spec §9.2) to
 * another context than `current`; null for every other link (same origin only).
 */
export function contextSwitchTarget(href: string, current: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  const requested = url.searchParams.get("account")?.trim().toLowerCase();
  return requested && requested !== current.trim().toLowerCase() ? url.href : null;
}

/**
 * Links inside `children` that switch to another trading-account context load the next page in full. The proxy stores
 * the new context on that request, and a full load renders the shared layout again, so the header's account selector
 * shows the context the next page uses (a client-side navigation keeps the layout, and with it the previous selection).
 * Plain clicks only: modified clicks, other targets and downloads keep the browser's behaviour. Charts and tables
 * render their drill-down links themselves, which is why this listens on the container instead of replacing links.
 */
export function ContextSwitchScope({ current, className, children }: { current: string; className?: string; children: ReactNode }) {
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const target = contextSwitchTarget(anchor.href, current, window.location.href);
    if (!target) return;
    event.preventDefault();
    window.location.assign(target);
  };
  return (
    <div className={className} onClickCapture={onClickCapture}>
      {children}
    </div>
  );
}
