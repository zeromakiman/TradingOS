"use client";

import { useEffect, useState } from "react";
import { nextBoundary, strategyClock } from "@/domain/session";
import { Tooltip } from "../ui/tooltip";
import { clockOffset, formatMinutes, minutesUntil, SESSION_LABELS } from "./session-labels";

const SECOND = 1000;

/**
 * Live strategy clock (fixed UTC−5, §13.3): time, current session and the next session
 * boundary (tooltip, accessible name, and visible on wide screens). It ticks every second
 * from the server's time (`nowIso`), so a skewed browser clock does not shift it.
 */
export function StrategyClock({ nowIso }: { nowIso: string }) {
  const serverNow = Date.parse(nowIso);
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const offset = clockOffset(serverNow, Date.now());
    const tick = () => setNow(Date.now() + offset);
    tick();
    const timer = window.setInterval(tick, SECOND);
    return () => window.clearInterval(timer);
  }, [serverNow]);

  if (!Number.isFinite(now)) return null;
  const instant = new Date(now);
  const clock = strategyClock(instant);
  const session = SESSION_LABELS[clock.session];
  const boundary = nextBoundary(instant);
  const countdown = formatMinutes(minutesUntil(Date.parse(boundary.at), now));
  const next = `${SESSION_LABELS[boundary.session]} at ${boundary.time}, in ${countdown}`;

  return (
    <Tooltip content={`Next: ${next}`}>
      <button type="button" className="strategy-clock" aria-label={`Strategy clock ${clock.time} UTC−5, ${session}. Next: ${next}.`}>
        <span className="strategy-clock-time">{clock.time}</span>
        <span className="max-lg:hidden">UTC−5</span>
        <span className="session-label" data-session={clock.session}>
          {session}
        </span>
        <span className="clock-next max-2xl:hidden">
          · {SESSION_LABELS[boundary.session]} in {countdown}
        </span>
      </button>
    </Tooltip>
  );
}
