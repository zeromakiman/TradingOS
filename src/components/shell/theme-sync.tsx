"use client";

import { useEffect } from "react";
import { applyTheme } from "./preferences";
import type { ThemePreference } from "./types";

/**
 * Keeps `<html data-theme>` in line with the stored preference. The root layout should
 * already render the attribute from the cookie (no flash); this covers client-side changes.
 */
export function ThemeSync({ theme }: { theme: ThemePreference }) {
  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) applyTheme(theme);
  }, [theme]);
  return null;
}
