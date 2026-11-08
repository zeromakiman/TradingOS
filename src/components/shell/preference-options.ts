import type { ThemePreference, TimeDisplayMode } from "./types";

export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export const TIME_DISPLAY_OPTIONS: { value: TimeDisplayMode; label: string }[] = [
  { value: "strategy", label: "Strategy time (UTC−5)" },
  { value: "local", label: "Local time" },
  { value: "utc", label: "UTC" },
];

export const isThemePreference = (value: string): value is ThemePreference => THEME_OPTIONS.some((option) => option.value === value);

export const isTimeDisplayMode = (value: string): value is TimeDisplayMode => TIME_DISPLAY_OPTIONS.some((option) => option.value === value);
