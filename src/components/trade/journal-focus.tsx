"use client";

import { useEffect } from "react";
import { revealTradeTarget, tradeTargetOf } from "./reveal";

/**
 * Links into the trade page open their target (`TRADE_TARGETS`): `/trades/<id>#close-trade`, `#record-entry`, `#review`,
 * `#entry-details`, `#evidence`, `#add-screenshots` scroll to the form or section and focus its first control (opening a
 * collapsed panel to reach it), `#journal` (Record Live Trade's "Start live journal", docs/V2_ARCHITECTURE.md §8.2,
 * §14.3) focuses the journal composer, `#technical-details` opens the disclosure. On a client navigation Next.js scrolls
 * while the loading skeleton is shown, before any target exists, so this runs once the trade is on the page (after the
 * first paint, so the browser's own jump to the anchor can't undo it) and again on every hash change. Mount it keyed by
 * the trade, so moving to another trade runs it again. Renders nothing.
 */
export function TradeHashFocus() {
  useEffect(() => {
    const revealFromHash = () => {
      const target = tradeTargetOf(window.location.hash);
      if (target) revealTradeTarget(target);
    };
    const frame = window.requestAnimationFrame(revealFromHash);
    window.addEventListener("hashchange", revealFromHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", revealFromHash);
    };
  }, []);
  return null;
}
