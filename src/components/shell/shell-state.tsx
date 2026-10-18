"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { persistSidebarPreference, persistSingleKeyShortcuts, readCookie, SHORTCUTS_COOKIE, SIDEBAR_COOKIE, singleKeyShortcutsEnabled } from "./preferences";

type ShellState = {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Single-key shortcuts (P, L, J, ?, /) are on; Ctrl/⌘+K always works. */
  singleKeyShortcuts: boolean;
  setSingleKeyShortcuts: (enabled: boolean) => void;
};

const ShellStateContext = createContext<ShellState | null>(null);

export type ShellStateProviderProps = {
  initialSidebarCollapsed: boolean;
  /** Stored choice (cookie `tos_shortcuts`); on by default. */
  initialSingleKeyShortcuts?: boolean;
  children: ReactNode;
};

/** Shared UI state of the shell: command palette, shortcut help, the sidebar rail and the single-key shortcut choice. */
export function ShellStateProvider({ initialSidebarCollapsed, initialSingleKeyShortcuts = true, children }: ShellStateProviderProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [singleKeyShortcuts, setSingleKeyShortcutsState] = useState(initialSingleKeyShortcuts);

  // Honour stored preferences when the layout did not pass them from the cookies.
  useEffect(() => {
    if (!initialSidebarCollapsed && readCookie(document.cookie, SIDEBAR_COOKIE) === "collapsed") setSidebarCollapsed(true);
  }, [initialSidebarCollapsed]);

  useEffect(() => {
    if (initialSingleKeyShortcuts && !singleKeyShortcutsEnabled(readCookie(document.cookie, SHORTCUTS_COOKIE))) setSingleKeyShortcutsState(false);
  }, [initialSingleKeyShortcuts]);

  const value = useMemo<ShellState>(
    () => ({
      paletteOpen,
      setPaletteOpen,
      helpOpen,
      setHelpOpen,
      sidebarCollapsed,
      toggleSidebar: () => {
        setSidebarCollapsed(!sidebarCollapsed);
        persistSidebarPreference(!sidebarCollapsed);
      },
      singleKeyShortcuts,
      setSingleKeyShortcuts: (enabled) => {
        setSingleKeyShortcutsState(enabled);
        persistSingleKeyShortcuts(enabled);
      },
    }),
    [paletteOpen, helpOpen, sidebarCollapsed, singleKeyShortcuts],
  );

  return <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>;
}

export function useShellState(): ShellState {
  const state = useContext(ShellStateContext);
  if (!state) throw new Error("Shell components must be rendered inside <AppShell>.");
  return state;
}

/** Root element of the shell; carries the sidebar state for the CSS grid. */
export function ShellFrame({ children }: { children: ReactNode }) {
  const { sidebarCollapsed } = useShellState();
  return (
    <div className="app-shell" data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}>
      {children}
    </div>
  );
}
