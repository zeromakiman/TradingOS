"use client";

import { SquarePen } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { completeLiveEntry } from "@/app/actions/trades";
import { randomUuid } from "@/components/evidence/use-evidence-stager";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import type { TimeDisplay } from "@/domain/time-display";
import { ActionMessage, useNotify } from "./action-message";
import { TRADE_COPY } from "./copy";
import { type DetailField, type DetailsDraft, EMPTY_DETAILS, validateEntryDetails } from "./form-model";
import { keepFocusOnTrade } from "./reveal";
import { wallClockOf, zoneHint } from "./time-input";
import { useFieldErrors } from "./use-field-errors";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * "Add entry details" of a live-first or imported position (docs/V2_ARCHITECTURE.md §3.5, §8.2): only the details that
 * are still missing, each recordable once (complete_live_entry never changes a recorded value). A contract makes P&L
 * calculable; a stop with a size, or a risk amount, makes realized R possible. Only filled fields are sent; the request
 * key makes a retry after a lost response a replay.
 */

export interface EntryDetailsFormProps {
  tradeId: string;
  requestKey: string;
  /** Missing details, in display order. */
  fields: readonly DetailField[];
  /** The account's contract for this symbol, when one exists (instrument field). */
  instruments: readonly { id: string; label: string }[];
  /** Link to add a contract when the account has none for this symbol. */
  manageInstrumentsHref: string;
  symbol: string | null;
  contract: { tickSize: string | null; quantityStep: string | null; unit: string };
  currency: string;
  /** The entry happened before the trade was recorded: the time can't be later. */
  recorded: { at: string; label: string };
  display: TimeDisplay;
}

const MODEL_OPTIONS = [
  { value: "OB_FIRST_TOUCH", label: "OB first touch" },
  { value: "OTE", label: "OTE" },
  { value: "OTHER", label: "Other" },
];

export function EntryDetailsForm({ tradeId, requestKey: firstKey, fields, instruments, manageInstrumentsHref, symbol, contract, currency, recorded, display }: EntryDetailsFormProps) {
  const notify = useNotify();
  const [draft, setDraft] = useState<DetailsDraft>(EMPTY_DETAILS);
  const [requestKey, setRequestKey] = useState(firstKey);
  const { state, pending, run, attempt } = useTradeAction(completeLiveEntry, result => {
    notify(result.message);
    keepFocusOnTrade();
    setDraft(EMPTY_DETAILS);
    setRequestKey(randomUuid());
  });
  const { errorOf, touch } = useFieldErrors(state, attempt);
  const offered = new Set(fields);
  const unit = contract.unit;

  const update = (field: DetailField, value: string) => {
    setDraft(current => ({ ...current, [field]: value }));
    touch(field);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const checked = validateEntryDetails(draft, {
      fields, ...contract, display,
      recordedAt: { instant: recorded.at, message: `The entry time can't be later than when the trade was recorded (${recorded.label}).` },
    });
    if (!checked.ok) {
      if (checked.message && !Object.keys(checked.fieldErrors).length) {
        run(new FormData(), { form: checked.message });
        return;
      }
      run(new FormData(), checked.fieldErrors as Record<string, string>);
      return;
    }
    run(formOf({ tradeId, requestKey, ...checked.fields }));
  };

  const formError = errorOf("form");

  return (
    <form noValidate onSubmit={submit} onKeyDown={submitOnModifierEnter} aria-labelledby="entry-details-heading" className="flex flex-col gap-4" data-form="entry-details">
      <div className="flex flex-col gap-1">
        <h3 id="entry-details-heading" className="text-sm font-semibold text-text">
          Add entry details
        </h3>
        <p className="t-meta">{TRADE_COPY.entryDetailsOnce}</p>
      </div>
      <div className="grid gap-4 @md:grid-cols-2">
        {offered.has("instrumentId") && (
          instruments.length > 0 ? (
            <Field label="Contract" id="entry-details-instrument" hint="Prices, size and P&L are then checked and calculated with its values." error={errorOf("instrumentId")}>
              <Select value={draft.instrumentId} disabled={pending} onChange={event => update("instrumentId", event.target.value)}>
                <option value="">Not set</option>
                {instruments.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <p className="field-label">Contract</p>
              <p className="t-meta">
                This account has no {symbol ?? "matching"} contract, so P&L can't be calculated from prices.{" "}
                <Link href={manageInstrumentsHref} className="font-medium text-accent underline-offset-2 hover:underline">
                  Add the instrument
                </Link>{" "}
                first, or report the net P&L when you close.
              </p>
            </div>
          )
        )}
        {offered.has("entryPrice") && (
          <Field label="Entry price" id="entry-details-price" error={errorOf("entryPrice")}>
            <DecimalInput value={draft.entryPrice} readOnly={pending} onValueChange={value => update("entryPrice", value)} />
          </Field>
        )}
        {offered.has("enteredAt") && (
          <Field label="Entry time" id="entry-details-time" hint={`Time in ${zoneHint(display, recorded.at)} · at or before ${recorded.label}`} error={errorOf("enteredAt")}>
            <Input
              type="datetime-local"
              step={60}
              max={wallClockOf(recorded.at, display)}
              value={draft.enteredAt}
              readOnly={pending}
              onChange={event => update("enteredAt", event.target.value)}
            />
          </Field>
        )}
        {offered.has("quantity") && (
          <Field label={unit ? `Size (${unit})` : "Size"} id="entry-details-size" error={errorOf("quantity")}>
            <DecimalInput value={draft.quantity} readOnly={pending} onValueChange={value => update("quantity", value)} />
          </Field>
        )}
        {offered.has("initialStop") && (
          <Field label="Initial stop" id="entry-details-stop" hint="The stop when you entered. Later moves go in the journal." error={errorOf("initialStop")}>
            <DecimalInput value={draft.initialStop} readOnly={pending} onValueChange={value => update("initialStop", value)} />
          </Field>
        )}
        {offered.has("riskAmount") && (
          <Field label="Risk amount" id="entry-details-risk" hint={`Money at risk at the stop, in ${currency}. Realized R uses it.`} error={errorOf("riskAmount")}>
            <DecimalInput value={draft.riskAmount} readOnly={pending} endAdornment={currency} onValueChange={value => update("riskAmount", value)} />
          </Field>
        )}
      </div>
      {offered.has("entryModel") && (
        <SegmentedControl
          name="entry-details-model"
          legend="Entry model"
          legendHidden={false}
          size="sm"
          options={MODEL_OPTIONS}
          value={draft.entryModel}
          disabled={pending}
          onValueChange={value => update("entryModel", value)}
        />
      )}
      {formError ? (
        <p role="alert" className="field-error">
          {formError}
        </p>
      ) : (
        <ActionMessage state={state} attempt={attempt} />
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="submit" variant="secondary" icon={<SquarePen aria-hidden="true" />} loading={pending} loadingText="Saving…">
          Save entry details
        </Button>
      </div>
    </form>
  );
}
