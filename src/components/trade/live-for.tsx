"use client";

import { useEffect, useState } from "react";
import { clockOffset } from "@/components/shell/session-labels";
import { formatDuration } from "@/domain/time-display";

const TICK_MS = 30_000;

/**
 * How long a position has been live (`45m`, `2h 15m`), counted from the server time of the render and kept current
 * while the page stays open. Server render and hydration use the server time exactly; afterwards the browser clock only
 * measures elapsed time (corrected by its offset from the server), so a wrong device clock never shows a wrong duration.
 */
export function LiveFor({ since, nowIso }: { since: string; nowIso: string }) {
  const serverNow = Date.parse(nowIso);
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const offset = clockOffset(serverNow, Date.now());
    const tick = () => setNow(Date.now() + offset);
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [serverNow]);

  if (!Number.isFinite(now)) return null;
  try {
    return <>{formatDuration(since, new Date(now).toISOString())}</>;
  } catch {
    return null;
  }
}
