"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";

/**
 * Phones show one breakdown at a time, picked from a list, instead of eight cards in a column; from 768px every card
 * is shown. All cards are in the HTML (server rendered); the picker only changes which one a phone displays.
 */

const SelectedBreakdown = createContext<string | null>(null);

export type BreakdownOption = { value: string; label: string };

export function BreakdownSwitch({ options, children }: { options: BreakdownOption[]; children: ReactNode }) {
  const [selected, setSelected] = useState(options[0]?.value ?? "");
  return (
    <SelectedBreakdown.Provider value={selected}>
      {options.length > 1 && (
        <Field label="Breakdown shown" labelHidden className="md:hidden">
          <Select value={selected} onChange={event => setSelected(event.target.value)}>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {children}
    </SelectedBreakdown.Provider>
  );
}

/** One breakdown card: hidden on phones unless it is the picked one. */
export function BreakdownPanel({ value, children }: { value: string; children: ReactNode }) {
  const selected = useContext(SelectedBreakdown);
  return <div className={cx(selected !== null && selected !== value && "max-md:hidden")}>{children}</div>;
}
