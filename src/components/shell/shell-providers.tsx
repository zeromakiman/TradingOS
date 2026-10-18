"use client";

import type { ReactNode } from "react";
import { DeveloperModeProvider } from "../ui/technical-details";
import { ToastProvider } from "../ui/toast";
import { ShellStateProvider } from "./shell-state";
import { TimeDisplayProvider } from "./time-display";
import type { TimeDisplay } from "./types";

export type ShellProvidersProps = {
  developerMode: boolean;
  timeDisplay: TimeDisplay;
  sidebarCollapsed: boolean;
  /** Single-key shortcuts are on (cookie `tos_shortcuts`); on by default. */
  singleKeyShortcuts?: boolean;
  children: ReactNode;
};

/** Client context for everything rendered inside the shell. */
export function ShellProviders({ developerMode, timeDisplay, sidebarCollapsed, singleKeyShortcuts = true, children }: ShellProvidersProps) {
  return (
    <DeveloperModeProvider value={developerMode}>
      <TimeDisplayProvider value={timeDisplay}>
        <ToastProvider>
          <ShellStateProvider initialSidebarCollapsed={sidebarCollapsed} initialSingleKeyShortcuts={singleKeyShortcuts}>
            {children}
          </ShellStateProvider>
        </ToastProvider>
      </TimeDisplayProvider>
    </DeveloperModeProvider>
  );
}
