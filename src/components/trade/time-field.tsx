"use client";

import { SegmentedControl } from "@/components/ui/choice";
import { Field } from "@/components/ui/field";
import type { TimeDisplay } from "@/domain/time-display";
import type { TimeChoice } from "./form-model";
import { wallClockOf, wallClockZone } from "./time-input";
import { ZonedTimeInput } from "./zoned-time-input";

/**
 * "Now / Earlier" time of an entry or exit (docs/V2_ARCHITECTURE.md §5.1, §14.3). Now is resolved by the server when
 * the form is sent, never from the browser clock; Earlier reveals a date-time field in the person's time display
 * (strategy UTC−5 by default) whose zone is shown beside the value and named in its label, and the form sends an
 * instant with an explicit zone. A local zone is named at the typed date (`wallClockZone`), with the offset the value
 * is converted with, also across a daylight-saving change.
 */

const OPTIONS = [
  { value: "now", label: "Now" },
  { value: "earlier", label: "Earlier" },
];

export interface TimeFieldProps {
  /** Form-unique id prefix (`entry-time`, `exit-time`). */
  id: string;
  legend: string;
  choice: TimeChoice;
  onChange(choice: TimeChoice): void;
  display: TimeDisplay;
  /** Server time of the page: the first value "Earlier" offers. */
  nowIso: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
}

export function TimeField({ id, legend, choice, onChange, display, nowIso, error, hint, disabled = false }: TimeFieldProps) {
  const { tag, hint: zone } = wallClockZone(choice.mode === "earlier" ? choice.wall : "", display, nowIso);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <SegmentedControl
        name={`${id}-mode`}
        legend={legend}
        legendHidden={false}
        size="sm"
        options={OPTIONS}
        value={choice.mode}
        disabled={disabled}
        onValueChange={value => onChange(value === "earlier" ? { mode: "earlier", wall: choice.mode === "earlier" ? choice.wall : wallClockOf(nowIso, display) } : { mode: "now" })}
      />
      {choice.mode === "earlier" ? (
        <Field label={`${legend}, date and time (${tag})`} labelHidden id={id} hint={[`Time in ${zone}`, hint].filter(Boolean).join(" · ")} error={error}>
          <ZonedTimeInput zone={tag} value={choice.wall} readOnly={disabled} onChange={event => onChange({ mode: "earlier", wall: event.target.value })} />
        </Field>
      ) : error ? (
        <p id={id} role="alert" className="field-error">
          {error}
        </p>
      ) : (
        <p id={id} className="t-caption">
          Uses the server's time when it is recorded.
        </p>
      )}
    </div>
  );
}
