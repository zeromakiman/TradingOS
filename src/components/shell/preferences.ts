import type { ThemePreference } from "./types";

/** Applies a theme to the document immediately (the server action persists it). */
export function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
}

/** The browser's IANA time zone ("Europe/Berlin"), which the "Local time" display needs; undefined when unknown. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Cookie the layout may read to render the sidebar collapsed on the server: "collapsed" | "expanded". */
export const SIDEBAR_COOKIE = "tos_sidebar";

/**
 * Cookie holding the single-key shortcut choice (P, L, J, ?, /): "off" turns them off (WCAG 2.2
 * SC 2.1.4), anything else leaves them on. The layout passes `singleKeyShortcutsEnabled(value)`
 * to AppShell as `singleKeyShortcuts`; the shell writes it when the person flips the switch.
 */
export const SHORTCUTS_COOKIE = "tos_shortcuts";

/** Single-key shortcuts are on unless the stored choice is "off". */
export function singleKeyShortcutsEnabled(cookieValue: string | null | undefined): boolean {
  return cookieValue !== "off";
}

type CookieStoreLike = { set(options: { name: string; value: string; path: string; expires: number; sameSite: "lax" }): Promise<void> };

const YEAR = 365 * 24 * 60 * 60 * 1000;

/** Stores a preference cookie for the next request; skipped where the Cookie Store API is unavailable. */
function persistCookie(name: string, value: string) {
  const store = (globalThis as { cookieStore?: CookieStoreLike }).cookieStore;
  store?.set({ name, value, path: "/", expires: Date.now() + YEAR, sameSite: "lax" }).catch(() => undefined);
}

/** Remembers the sidebar state for the next request. */
export function persistSidebarPreference(collapsed: boolean) {
  persistCookie(SIDEBAR_COOKIE, collapsed ? "collapsed" : "expanded");
}

/** Remembers the single-key shortcut choice for the next request. */
export function persistSingleKeyShortcuts(enabled: boolean) {
  persistCookie(SHORTCUTS_COOKIE, enabled ? "on" : "off");
}

/** The value of a cookie in a `document.cookie` string, or undefined. */
export function readCookie(cookies: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = cookies.split("; ").find((part) => part.startsWith(prefix));
  return entry?.slice(prefix.length);
}
