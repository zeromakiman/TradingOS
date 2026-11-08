"use client";

import { type FormEvent, useState } from "react";
import { createInstrument } from "@/app/actions/accounts";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ActionFeedback } from "./action-feedback";
import { tickValueNote } from "./copy";
import { DECIMAL_COPY, type FieldRule } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

const INSTRUMENT_RULES: Readonly<Record<string, FieldRule>> = {
  symbol: { kind: "symbol", message: "Use 1 to 20 capital letters, digits or . _ / - for the symbol." },
  quantityUnit: { kind: "text", max: 60, message: "Describe the size unit (1 to 60 characters), for example “lots (100,000 EUR)”." },
  tickSize: { kind: "decimal", message: DECIMAL_COPY("Tick size") },
  pipSize: { kind: "decimal", optional: true, message: DECIMAL_COPY("Pip size") },
  tickValue: { kind: "decimal", message: "Tick value must be a positive amount in the account currency, with up to 8 decimals." },
  quantityStep: { kind: "decimal", message: DECIMAL_COPY("Size step") },
  minimumQuantity: { kind: "decimal", message: DECIMAL_COPY("Minimum size") },
};

/**
 * Add an instrument version (spec §3.2 create_instrument_version). A new version of an existing symbol replaces it in
 * new plans; trades already written keep the version they used. Tick value is in the account currency.
 */

/** The current version of a symbol, prefilled into its "New version" form. */
export interface InstrumentDraft {
  /** The version the values come from; a newer version (after a save) refills the fields. */
  versionId: string;
  symbol: string;
  quantityUnit: string;
  tickSize: string;
  pipSize: string | null;
  tickValue: string;
  quantityStep: string;
  minimumQuantity: string;
}

export interface InstrumentFormProps {
  accountId: string;
  currency: string;
  initial: InstrumentDraft | null;
}

/**
 * Identity of a prefill. The "New version" links and "Start empty" stay on the same page, and the decimal fields copy
 * their initial value once, so each symbol (and the empty form) must be its own form instance: otherwise the fields
 * keep the previous symbol's contract values under the new symbol's name.
 */
export function instrumentDraftKey(initial: InstrumentDraft | null): string {
  return initial ? `symbol:${initial.symbol}` : "new";
}

export function InstrumentForm(props: InstrumentFormProps) {
  return <InstrumentFormFields key={instrumentDraftKey(props.initial)} {...props} />;
}

function InstrumentFormFields({ accountId, currency, initial }: InstrumentFormProps) {
  const [generation, setGeneration] = useState(0);
  const { state, pending, run, feedbackKey } = useAccountAction<{ instrumentId: string }>(createInstrument, () => setGeneration(value => value + 1));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("accountId", accountId);
    run(form, INSTRUMENT_RULES);
  };
  const error = (key: string) => fieldError(state, key);
  // Saved: fresh fields; and once the saved version is the current one, its values (the feedback above stays).
  const formKey = `form-${generation}-${initial?.versionId ?? "new"}`;
  return (
    <div className="flex flex-col gap-4">
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <form key={formKey} noValidate onSubmit={submit} className="flex flex-col gap-4" aria-label="Add instrument version" aria-busy={pending}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Symbol" required error={error("symbol")} hint="Capital letters and digits, for example EURUSD or DE40.">
            <Input name="symbol" defaultValue={initial?.symbol ?? ""} maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={pending} />
          </Field>
          <Field label="Size unit" required error={error("quantityUnit")} hint="What one unit of size is, for example “lots (100,000 EUR)”.">
            <Input name="quantityUnit" defaultValue={initial?.quantityUnit ?? ""} maxLength={60} autoComplete="off" disabled={pending} />
          </Field>
          <Field label="Tick size" required error={error("tickSize")} hint="Smallest price step, for example 0.00001.">
            <DecimalInput name="tickSize" defaultValue={initial?.tickSize ?? ""} disabled={pending} />
          </Field>
          <Field label="Pip size" optional error={error("pipSize")} hint="Used to show distances in pips, for example 0.0001.">
            <DecimalInput name="pipSize" defaultValue={initial?.pipSize ?? ""} disabled={pending} />
          </Field>
          <Field label="Tick value" required error={error("tickValue")} hint={tickValueNote(currency)}>
            <DecimalInput name="tickValue" defaultValue={initial?.tickValue ?? ""} endAdornment={<span aria-hidden="true">{currency}</span>} disabled={pending} />
          </Field>
          <Field label="Size step" required error={error("quantityStep")} hint="Increment of the position size, for example 0.01.">
            <DecimalInput name="quantityStep" defaultValue={initial?.quantityStep ?? ""} disabled={pending} />
          </Field>
          <Field label="Minimum size" required error={error("minimumQuantity")} hint="Smallest position your broker accepts.">
            <DecimalInput name="minimumQuantity" defaultValue={initial?.minimumQuantity ?? ""} disabled={pending} />
          </Field>
        </div>
        <p className="t-meta">Check these values against your broker's contract specification. Position sizes and risk are computed from them exactly.</p>
        <div>
          <Button type="submit" variant="secondary" loading={pending} loadingText="Saving…">
            {initial ? "Save new version" : "Add instrument"}
          </Button>
        </div>
      </form>
    </div>
  );
}
