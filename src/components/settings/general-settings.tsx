"use client";

import { useEffect, useState } from "react";
import { setTheme, setTimeDisplay } from "@/app/actions/context";
import { formatTime, STRATEGY_TIME, STRATEGY_ZONE_LABEL, type TimeDisplay } from "@/domain/time-display";
import { browserTimeZone } from "../shell/preferences";
import { THEME_OPTIONS } from "../shell/preference-options";
import type { ThemePreference } from "../shell/types";
import { useThemeChoice, useTimeDisplayChoice } from "../shell/use-preference-controls";
import { RadioCards, SegmentedControl } from "../ui/choice";

/**
 * Settings → General (docs/V2_ARCHITECTURE.md §13.1, §6.6): theme and time display. Both reuse the shell's preference
 * hooks, so a choice applies at once, persists through the context actions and is reverted with a toast when saving
 * fails. Each time option shows the current time in that clock, ticking from the server's time.
 */

const MINUTE = 60_000;

function useServerClock(nowIso: string): number {
  const serverNow = Date.parse(nowIso);
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const offset = serverNow - Date.now();
    const tick = () => setNow(Date.now() + offset);
    tick();
    const timer = window.setInterval(tick, MINUTE / 2);
    return () => window.clearInterval(timer);
  }, [serverNow]);
  return now;
}

function timeIn(now: number, display: TimeDisplay): string | null {
  if (!Number.isFinite(now)) return null;
  try {
    return formatTime(new Date(now), display);
  } catch {
    return null;
  }
}

export function GeneralSettings({ theme, timeDisplay, nowIso }: { theme: ThemePreference; timeDisplay: TimeDisplay; nowIso: string }) {
  const [currentTheme, changeTheme] = useThemeChoice(theme, setTheme);
  const [timeMode, changeTimeMode] = useTimeDisplayChoice(timeDisplay.mode, setTimeDisplay);
  const now = useServerClock(nowIso);
  // The device zone is known only in the browser; the server render leaves it out.
  const [zone, setZone] = useState<string | undefined>(timeDisplay.mode === "local" ? timeDisplay.zone : undefined);
  useEffect(() => setZone(browserTimeZone()), []);

  const strategyNow = timeIn(now, STRATEGY_TIME);
  const utcNow = timeIn(now, { mode: "utc" });
  const localNow = zone ? timeIn(now, { mode: "local", zone }) : null;
  const options = [
    {
      value: "strategy",
      label: `Strategy time (${STRATEGY_ZONE_LABEL})`,
      description: `The fixed clock of trading days, sessions and daily limits.${strategyNow ? ` Now ${strategyNow}.` : ""}`,
    },
    {
      value: "local",
      label: "Local time",
      description: `This device's time zone${zone ? ` (${zone.replaceAll("_", " ")})` : ""}.${localNow ? ` Now ${localNow}.` : ""}`,
    },
    { value: "utc", label: "UTC", description: `Coordinated Universal Time.${utcNow ? ` Now ${utcNow}.` : ""}` },
  ];

  return (
    <div className="flex flex-col divide-y divide-border">
      <div className="flex flex-col gap-3 pb-5 md:flex-row md:items-start md:justify-between md:gap-8">
        <div className="min-w-0 md:max-w-xs">
          <p className="font-semibold text-text">
            Theme
          </p>
          <p className="t-meta">System follows your device's light or dark setting.</p>
        </div>
        <SegmentedControl name="theme" legend="Theme" options={THEME_OPTIONS} value={currentTheme} onValueChange={changeTheme} />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <div>
          <p className="font-semibold text-text">Time display</p>
          <p className="t-meta">
            Only how times are shown changes. Trading days, sessions and daily limits always use fixed {STRATEGY_ZONE_LABEL}, with no daylight-saving
            shifts.
          </p>
        </div>
        <RadioCards name="timeDisplay" legend="Time display" legendHidden options={options} value={timeMode} onValueChange={changeTimeMode} />
      </div>
    </div>
  );
}
