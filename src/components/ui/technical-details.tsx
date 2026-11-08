"use client";

import { createContext, type ReactNode, useContext } from "react";
import { cx } from "./cx";
import { Disclosure } from "./disclosure";

const DeveloperModeContext = createContext(false);

/** Provides the developer-mode flag (cookie `tos_dev`, §13.9); AppShell mounts it. */
export function DeveloperModeProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <DeveloperModeContext.Provider value={value}>{children}</DeveloperModeContext.Provider>;
}

export function useDeveloperMode() {
  return useContext(DeveloperModeContext);
}

export type TechnicalDetailsProps = {
  children: ReactNode;
  summary?: ReactNode;
  /** Overrides the developer-mode flag from context; `true` renders the disclosure open. */
  developerMode?: boolean;
  className?: string;
};

/**
 * Collapsed disclosure for ids, versions, hashes, raw reports and provider details (§13.9).
 * The content is always in the server HTML; developer mode only changes the initial state.
 */
export function TechnicalDetails({ children, summary = "Technical details", developerMode, className }: TechnicalDetailsProps) {
  const contextDeveloperMode = useDeveloperMode();
  return (
    <Disclosure summary={summary} open={developerMode ?? contextDeveloperMode} className={cx("technical-details", className)}>
      {children}
    </Disclosure>
  );
}
