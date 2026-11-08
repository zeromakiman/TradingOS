"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useTransition } from "react";
import { type DayFormat, formatDateTime, formatDay, formatTime, type Instant, STRATEGY_TIME, zoneLabel } from "@/domain/time-display";
import { callShellAction, timeDisplayFields } from "./actions";
import { browserTimeZone } from "./preferences";
import type { SetTimeDisplayAction, TimeDisplay } from "./types";

const TimeDisplayContext = createContext<TimeDisplay>(STRATEGY_TIME);

/** Makes the user's time display (strategy UTC−5, local or UTC) available to client components. */
export function TimeDisplayProvider({ value, children }: { value: TimeDisplay; children: ReactNode }) {
  return <TimeDisplayContext.Provider value={value}>{children}</TimeDisplayContext.Provider>;
}

/** The current time display; defaults to the fixed UTC−5 strategy clock. */
export function useTimeDisplay(): TimeDisplay {
  return useContext(TimeDisplayContext);
}

/**
 * Formatters bound to the current time display, for client components (server components
 * call the src/domain/time-display.ts functions with the display the page loaded):
 * `time` "09:42", `dateTime` "Oct 14, 09:42", `day` "Oct 14", `zone` "UTC−5".
 */
export function useTimeFormat() {
  const display = useTimeDisplay();
  return useMemo(
    () => ({
      display,
      time: (instant: Instant) => formatTime(instant, display),
      dateTime: (instant: Instant, options?: DayFormat) => formatDateTime(instant, display, options),
      day: (value: Instant, options?: DayFormat) => formatDay(value, display, options),
      zone: (at?: Instant) => zoneLabel(display, at),
    }),
    [display],
  );
}

/**
 * Keeps "Local time" on the device's current zone (for example after travelling): when the
 * persisted zone differs from the browser's, the preference is saved again with the new one.
 */
export function LocalTimeZoneSync({ timeDisplay, setTimeDisplayAction }: { timeDisplay: TimeDisplay; setTimeDisplayAction?: SetTimeDisplayAction }) {
  const { mode, zone } = timeDisplay;
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (mode !== "local" || !setTimeDisplayAction) return;
    const current = browserTimeZone();
    // A failed refresh keeps the stored zone; the next page load tries again.
    if (!current || current === zone) return;
    startTransition(async () => {
      await callShellAction(setTimeDisplayAction, timeDisplayFields("local", current));
    });
  }, [mode, zone, setTimeDisplayAction]);
  return null;
}
