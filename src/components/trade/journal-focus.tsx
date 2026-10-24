"use client";

import { useEffect } from "react";
import { focusComposer, TRADE_TARGETS } from "./reveal";

/**
 * `/trades/<id>#journal` (Record Live Trade's "Start live journal", docs/V2_ARCHITECTURE.md §8.2, §14.3) opens the
 * page with the journal composer focused, ready for the first note. Renders nothing.
 */
export function JournalHashFocus() {
  useEffect(() => {
    const focusFromHash = () => {
      if (window.location.hash === `#${TRADE_TARGETS.journal}`) focusComposer();
    };
    // After the first paint, so the browser's own jump to the anchor doesn't undo the composer's scroll position.
    const frame = window.requestAnimationFrame(focusFromHash);
    window.addEventListener("hashchange", focusFromHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", focusFromHash);
    };
  }, []);
  return null;
}
