"use client";

import { SegmentedControl } from "../ui/choice";
import { TIME_DISPLAY_OPTIONS } from "./preference-options";
import type { SetTimeDisplayAction, TimeDisplayMode } from "./types";
import { useTimeDisplayChoice } from "./use-preference-controls";

export type TimeDisplaySwitcherProps = {
  mode: TimeDisplayMode;
  /** Persists the choice (cookies `tos_time`/`tos_tz`) and re-renders times; without it the switch is disabled. */
  setTimeDisplayAction?: SetTimeDisplayAction;
  name?: string;
  legend?: string;
  legendHidden?: boolean;
};

/** Strategy time (UTC−5) · Local time · UTC switch (Settings → General, user menus, the developer gallery). */
export function TimeDisplaySwitcher({ mode, setTimeDisplayAction, name = "time-display", legend = "Time display", legendHidden = false }: TimeDisplaySwitcherProps) {
  const [current, change] = useTimeDisplayChoice(mode, setTimeDisplayAction);
  return (
    <SegmentedControl
      name={name}
      legend={legend}
      legendHidden={legendHidden}
      options={TIME_DISPLAY_OPTIONS}
      value={current}
      onValueChange={change}
      disabled={!setTimeDisplayAction}
    />
  );
}
