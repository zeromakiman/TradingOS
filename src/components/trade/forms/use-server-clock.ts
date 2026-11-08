"use client";

import { useEffect, useState } from "react";

/**
 * The server's time, kept current while the page stays open (V1 finding C8, spec §6.4): monotonic elapsed time
 * (`performance.now()`) is added to the time the server rendered the page with, so the preview's session and strategy
 * day follow the clock even when the browser clock is wrong. The first render (server and hydration) uses `serverNow`.
 */
export function useServerClock(serverNow: string, intervalMs = 10_000): string {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const anchor = Date.parse(serverNow);
    if (!Number.isFinite(anchor)) return;
    const startedAt = performance.now();
    const tick = () => setNow(new Date(anchor + (performance.now() - startedAt)).toISOString());
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [serverNow, intervalMs]);
  return now;
}
