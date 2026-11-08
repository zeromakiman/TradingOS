"use client";

import { LogIn, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ActionState } from "@/app/actions/state";
import { type EntryResult, recordEntry } from "@/app/actions/trades";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import type { TimeDisplay } from "@/domain/time-display";
import { ActionMessage, useNotify } from "./action-message";
import { ENTRY_COPY, entrySubmission, type ReviewFact } from "./close-model";
import { TRADE_COPY } from "./copy";
import { type EntryDraft, oversizeWarning } from "./form-model";
import { RecordConfirmDialog, useRecordConfirmation } from "./record-confirm-dialog";
import { keepFocusOnTrade } from "./reveal";
import { TimeField } from "./time-field";
import { useFieldErrors } from "./use-field-errors";
import { callTradeAction, formOf, useTradeAction } from "./use-trade-action";

/**
 * Record entry of a locked plan (docs/V2_ARCHITECTURE.md §3.4, §8.5): the fill price and size, prefilled from the plan,
 * and the entry time (Now, or Earlier in the person's time display). A size above the plan shows the exact deviation
 * sentence of `sizeDeviationWarning` and needs an explicit confirmation, which the server checks again. The fill is
 * recorded once; the page then shows the trade as live. An entry at the plan's price and size, now, is recorded at
 * once; anything the trader typed (another price or size, an earlier time) is shown for confirmation first, with the
 * difference from the plan, so a typo pressed in with Enter is never recorded unseen (spec §57).
 */

export interface RecordEntryFormProps {
  tradeId: string;
  /** Prefilled values: the plan's entry at the tick scale and its size at the step scale. */
  defaults: { entry: string; quantity: string };
  /** The plan's values for the hints (formatted) and its exact planned size (for the oversize check). */
  planned: { entry: string | null; quantity: string | null; quantityExact: string | null };
  contract: { tickSize: string | null; quantityStep: string | null; unit: string };
  /** The entry can't be earlier than the lock: the bound and its time in words. */
  locked: { at: string; label: string } | null;
  display: TimeDisplay;
  nowIso: string;
}

export function RecordEntryForm({ tradeId, defaults, planned, contract, locked, display, nowIso }: RecordEntryFormProps) {
  const notify = useNotify();
  const [draft, setDraft] = useState<EntryDraft>({ entry: defaults.entry, quantity: defaults.quantity, time: { mode: "now" }, confirmOversize: false });
  const recorded = (result: { message?: string }) => {
    notify(result.message);
    keepFocusOnTrade();
  };
  const { state, pending, run, show, reset, attempt } = useTradeAction(recordEntry, recorded);
  const confirmation = useRecordConfirmation<{ fields: Record<string, string>; facts: ReviewFact[] }, EntryResult>(show);
  const review = confirmation.pending;
  const { errorOf, touch } = useFieldErrors(state, attempt);
  const warning = oversizeWarning(draft.quantity, planned.quantityExact, contract.quantityStep);
  const unit = contract.unit;

  const update = (patch: Partial<EntryDraft>, field: string) => {
    setDraft(current => ({ ...current, ...patch }));
    touch(field);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || review) return;
    const next = entrySubmission(draft, { planned: { entry: planned.entry, quantity: planned.quantityExact }, contract, display, locked });
    if (next.kind === "invalid") {
      run(new FormData(), next.fieldErrors as Record<string, string>);
      return;
    }
    if (next.kind === "send") {
      run(formOf({ tradeId, ...next.fields }));
      return;
    }
    // Something the trader typed differs from the plan or from Now: it is recorded only once they confirm it.
    reset();
    confirmation.open(event, { fields: next.fields, facts: next.facts });
  };

  const confirm = async (): Promise<ActionState<EntryResult>> => {
    if (!review) return { status: "error", message: TRADE_COPY.connectionLost };
    const result = await callTradeAction(recordEntry, formOf({ tradeId, ...review.fields }));
    if (result.status === "success") recorded(result);
    return result;
  };

  return (
    <>
      <form noValidate onSubmit={submit} onKeyDown={submitOnModifierEnter} aria-label="Record entry" className="flex flex-col gap-4" data-form="record-entry">
        <div className="grid gap-4 @md:grid-cols-2">
          <Field label="Entry price" required id="record-entry-price" hint={planned.entry ? `Plan ${planned.entry}` : undefined} error={errorOf("entry")}>
            <DecimalInput value={draft.entry} readOnly={pending} onValueChange={entry => update({ entry }, "entry")} />
          </Field>
          <Field
            label={unit ? `Size (${unit})` : "Size"}
            required
            id="record-entry-size"
            hint={planned.quantity ? `Plan ${planned.quantity}${unit ? ` ${unit}` : ""}` : undefined}
            error={errorOf("quantity")}
          >
            <DecimalInput value={draft.quantity} readOnly={pending} onValueChange={quantity => update({ quantity, confirmOversize: false }, "quantity")} />
          </Field>
        </div>
        <TimeField
          id="record-entry-time"
          legend="Entry time"
          choice={draft.time}
          onChange={time => update({ time }, "enteredAt")}
          display={display}
          nowIso={nowIso}
          hint={locked ? `after the lock at ${locked.label}` : undefined}
          error={errorOf("enteredAt")}
          disabled={pending}
        />
        {warning && (
          <div className="flex flex-col gap-2 rounded-control border border-warn-border bg-warn-soft p-3" data-warning="oversize">
            <p className="flex items-start gap-2 text-warn">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none" />
              <span className="font-medium">{warning}</span>
            </p>
            <Checkbox
              label="Record the size deviation"
              checked={draft.confirmOversize}
              disabled={pending}
              aria-invalid={errorOf("confirmOversize") ? true : undefined}
              onChange={event => update({ confirmOversize: event.target.checked }, "confirmOversize")}
            />
            {errorOf("confirmOversize") && (
              <p className="field-error" role="alert">
                {errorOf("confirmOversize")}
              </p>
            )}
          </div>
        )}
        <ActionMessage state={state} attempt={attempt} />
        <div className="flex flex-col-reverse gap-2 @md:flex-row @md:items-center @md:justify-between @md:gap-3">
          <p className="t-caption">Recorded once: the fill can't be changed later.</p>
          <Button type="submit" icon={<LogIn aria-hidden="true" />} loading={pending} loadingText="Recording…" className="w-full @md:w-auto">
            Record entry
          </Button>
        </div>
      </form>
      {/* Outside the form: the dialog's key presses and clicks never reach the form's own handlers. */}
      <RecordConfirmDialog
        open={review !== null}
        title={ENTRY_COPY.dialogTitle}
        description={ENTRY_COPY.dialogDescription}
        confirmLabel={ENTRY_COPY.confirm}
        pendingLabel={ENTRY_COPY.pending}
        cancelLabel={ENTRY_COPY.keepEditing}
        groups={review ? [{ title: ENTRY_COPY.section, facts: review.facts }] : []}
        onConfirm={confirm}
        onClosed={confirmation.closed}
      />
    </>
  );
}
