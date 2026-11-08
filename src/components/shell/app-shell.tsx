import type { ReactNode } from "react";
import { STRATEGY_TIME } from "@/domain/time-display";
import { AccountContextSync } from "./account-context-sync";
import { CommandPalette } from "./command-palette";
import { ContextNotice } from "./context-notice";
import { GlobalShortcuts } from "./global-shortcuts";
import { MobileTabBar } from "./mobile-tab-bar";
import { ShellProviders } from "./shell-providers";
import { ShellFrame } from "./shell-state";
import { ShortcutHelp } from "./shortcut-help";
import { Sidebar } from "./sidebar";
import { ThemeSync } from "./theme-sync";
import { LocalTimeZoneSync } from "./time-display";
import { TopBar } from "./top-bar";
import type {
  AccountContextSelection,
  PaletteIndex,
  SelectAccountAction,
  SetThemeAction,
  SetTimeDisplayAction,
  ShellAccount,
  SignOutAction,
  ThemePreference,
  TimeDisplay,
} from "./types";

export type AppShellProps = {
  user: { email: string };
  accounts: ShellAccount[];
  context: AccountContextSelection;
  /** Server time of this request (ISO 8601 with zone); the strategy clock ticks from it. */
  clock: { nowIso: string };
  paletteIndex: PaletteIndex;
  /** Cookie `tos_dev`: Technical details render expanded (§13.9). */
  developerMode: boolean;
  /** Stored theme (cookie `tos_theme`); the root layout should also render it as `<html data-theme>`. */
  theme: ThemePreference;
  /** `resolveTimeDisplay(tos_time, tos_tz)` from src/domain/time-display.ts; strategy time when omitted. */
  timeDisplay?: TimeDisplay;
  /** Cookie `tos_sidebar` = "collapsed" renders the desktop sidebar as an icon rail. */
  sidebarCollapsed?: boolean;
  /**
   * Single-key shortcuts (P, L, J, ?, /) are on: `singleKeyShortcutsEnabled(tos_shortcuts)` from
   * ./preferences. The person turns them off in the Keyboard shortcuts dialog or Settings → General.
   */
  singleKeyShortcuts?: boolean;
  /**
   * One-time context notice, for example "That trading account isn't available. Showing All Accounts." (§9.2), shown
   * on the page it was rendered for (./context-notice.tsx).
   */
  notice?: string | null;
  /**
   * The notice comes from the stored context itself (an account archived on another device, or left by someone else's
   * session): the shell stores All Accounts once, so the next pages render without it.
   */
  storedContextUnavailable?: boolean;
  selectAccountAction?: SelectAccountAction;
  setThemeAction?: SetThemeAction;
  setTimeDisplayAction?: SetTimeDisplayAction;
  signOutAction?: SignOutAction;
  children: ReactNode;
};

/**
 * Authenticated application chrome (§13.3): sidebar or icon rail, top bar with the account
 * selector, strategy clock, search and primary actions, mobile tab bar, command palette,
 * shortcut help and toasts. Purely presentational: the layout loads every prop.
 */
export function AppShell({
  user,
  accounts,
  context,
  clock,
  paletteIndex,
  developerMode,
  theme,
  timeDisplay = STRATEGY_TIME,
  sidebarCollapsed = false,
  singleKeyShortcuts = true,
  notice,
  storedContextUnavailable = false,
  selectAccountAction,
  setThemeAction,
  setTimeDisplayAction,
  signOutAction,
  children,
}: AppShellProps) {
  const preferences = { email: user.email, theme, timeDisplay, setThemeAction, setTimeDisplayAction, signOutAction };
  return (
    <ShellProviders developerMode={developerMode} timeDisplay={timeDisplay} sidebarCollapsed={sidebarCollapsed} singleKeyShortcuts={singleKeyShortcuts}>
      <ThemeSync theme={theme} />
      <LocalTimeZoneSync timeDisplay={timeDisplay} setTimeDisplayAction={setTimeDisplayAction} />
      {/* The header and the palette show the context of the page on screen, also after client-side navigations. */}
      <AccountContextSync accounts={accounts} context={context} storedUnavailable={storedContextUnavailable} selectAccountAction={selectAccountAction}>
        <ShellFrame>
          <a className="skip-link" href="#main-content">
            Skip to main content
          </a>
          <Sidebar {...preferences} />
          <div className="app-main">
            <TopBar accounts={accounts} context={context} nowIso={clock.nowIso} selectAccountAction={selectAccountAction} />
            <main id="main-content" tabIndex={-1} className="app-content">
              {/* The server time of this layout render identifies it: a new render may bring a new notice. */}
              <ContextNotice notice={notice} renderKey={clock.nowIso} />
              {children}
            </main>
          </div>
          <MobileTabBar {...preferences} />
        </ShellFrame>
        <CommandPalette index={paletteIndex} context={context} userEmail={user.email} selectAccountAction={selectAccountAction} />
      </AccountContextSync>
      <ShortcutHelp />
      <GlobalShortcuts />
    </ShellProviders>
  );
}
