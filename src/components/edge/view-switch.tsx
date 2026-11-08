"use client";

import { createContext, type ReactNode, useContext, useState } from "react";

/**
 * Switches between server-rendered variants of one chart (daily Net R / Net P&L per currency) without a round trip:
 * every variant is in the HTML, one is shown. The buttons sit in each variant's chart header.
 */

type ViewSwitchValue = { value: string; select: (value: string) => void };

const ViewSwitchContext = createContext<ViewSwitchValue | null>(null);

export function ViewSwitch({ defaultValue, children }: { defaultValue: string; children: ReactNode }) {
  const [value, select] = useState(defaultValue);
  return <ViewSwitchContext.Provider value={{ value, select }}>{children}</ViewSwitchContext.Provider>;
}

/** Segmented toggle buttons (`aria-pressed`) for the variants. */
export function ViewSwitchButtons({ label, options }: { label: string; options: { value: string; label: string }[] }) {
  const context = useContext(ViewSwitchContext);
  if (!context || options.length < 2) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset.
    <div className="segmented segmented-sm" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" className="segmented-label" aria-pressed={context.value === option.value} onClick={() => context.select(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One variant; hidden unless selected (the first render shows the default). */
export function ViewPanel({ value, children }: { value: string; children: ReactNode }) {
  const context = useContext(ViewSwitchContext);
  return <div hidden={(context?.value ?? value) !== value}>{children}</div>;
}
