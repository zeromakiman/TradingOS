"use client";

import type { MouseEvent, ReactNode } from "react";
import { plainClick } from "./transition-link";

/**
 * Links that switch the trading-account context (docs/V2_ARCHITECTURE.md §9.2) load the next page in full.
 *
 * `?account=all|<id>` is applied by the proxy, which stores the new context on that request. A client-side navigation
 * keeps the shared layout, and with it the header's Trading Account selector, so after one the header would still name
 * the previous context while the page shows another. A full load renders the layout again. The Review page renders such
 * links itself (the Journal drill-down and AI settings in All Accounts, "Show every account" in History) and through
 * shared components (the review panel's "Open AI settings"), which is why this listens on the page instead of replacing
 * links. Links that keep the context stay client-side, and without JavaScript every link is a full load anyway.
 */

/** The values the proxy accepts for `?account=`; anything else leaves the context unchanged. */
const CONTEXT_VALUE = /^(?:all|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The address to load in full for a same-origin link whose `?account=` names another context than `current` (`all` or
 * an account id); null for every other link.
 */
export function contextSwitchHref(href: string, current: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  // The proxy reads the first value, like URLSearchParams#get.
  const requested = url.searchParams.get("account")?.trim().toLowerCase();
  if (!requested || !CONTEXT_VALUE.test(requested)) return null;
  return requested === current.trim().toLowerCase() ? null : url.href;
}

/**
 * Plain clicks on a context-switching link inside `children` load its page in full. Modified clicks, other targets and
 * downloads keep the browser's behaviour. `current` is this render's context (`all` or the selected account's id).
 */
export function ReviewContextScope({ current, className, children }: { current: string; className?: string; children: ReactNode }) {
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!plainClick(event) || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || !event.currentTarget.contains(anchor)) return;
    if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const target = contextSwitchHref(anchor.href, current, window.location.href);
    if (target === null) return;
    // Handled here, so the link's own client-side navigation (next/link, TransitionLink) leaves it alone.
    event.preventDefault();
    window.location.assign(target);
  };
  return (
    <div className={className} data-account-context={current} onClickCapture={onClickCapture}>
      {children}
    </div>
  );
}
