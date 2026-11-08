"use client";

import { SegmentedControl } from "../ui/choice";
import { THEME_OPTIONS } from "./preference-options";
import type { SetThemeAction, ThemePreference } from "./types";
import { useThemeChoice } from "./use-preference-controls";

export type ThemeSwitcherProps = {
  theme: ThemePreference;
  /** Persists the choice (cookie `tos_theme`); without it the switch only affects this page view. */
  setThemeAction?: SetThemeAction;
  name?: string;
  legend?: string;
  legendHidden?: boolean;
};

/** Light · Dark · System switch (Settings → General, user menus, the developer gallery). */
export function ThemeSwitcher({ theme, setThemeAction, name = "theme", legend = "Theme", legendHidden = false }: ThemeSwitcherProps) {
  const [current, change] = useThemeChoice(theme, setThemeAction);
  return <SegmentedControl name={name} legend={legend} legendHidden={legendHidden} options={THEME_OPTIONS} value={current} onValueChange={change} />;
}
