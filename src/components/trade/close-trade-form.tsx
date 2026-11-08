"use client";

import { Info, LogOut } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ActionState } from "@/app/actions/state";
import { type CloseResult, closeLiveTrade, closePlannedTrade } from "@/app/actions/trades";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import { formatPrice } from "@/domain/format";
import { averageExit, type CloseLegs, onTick } from "@/domain/partial-closes";
import type { TimeDisplay } from "@/domain/time-display";
import { ActionMessage, useNotify } from "./action-message";
import {
  AVERAGE_REASON_COPY, averageFormula, CLOSE_COPY, type CloseFormContext, type CloseFormMode, type CloseReview, closeResultShown, closeSubmission, legLabel,
  recordLabel, restPriceLabel,
} from "./close-model";
import { TRADE_COPY } from "./copy";
import { type CloseDraft, closeFieldOf, isAligned, isPositiveDecimal, type PnlKind } from "./form-model";
import { RecordConfirmDialog, useRecordConfirmation } from "./record-confirm-dialog";
import { keepFocusOnTrade } from "./reveal";
import { TimeField } from "./time-field";
import { useFieldErrors } from "./use-field-errors";
import { callTradeAction, formOf, useTradeAction } from "./use-trade-action";

/**
 * Close trade (docs/V2_ARCHITECTURE.md §3.4–3.6, §8.2): one exit for the whole position. A planned trade sends exit,
 * time and fees (FULL_CLOSE_V1, R = net P&L ÷ locked risk). A live-first trade sends the exit price when its P&L can be
 * calculated from the recorded contract, entry and size, and otherwise the net P&L the trader reports, whose sign is
 * chosen explicitly (Profit, Loss or Breakeven), so a loss is never recorded as a profit by default.
 *
 * The close is recorded once and can't be corrected, so nothing is sent from the button, Enter or Ctrl/⌘+Enter alone
 * (spec §57): they open a confirmation with the exit, time and fees and the result the database will compute from them
 * (outcome, net P&L, realized R), and only the confirmation records the close. The result is worked out from the
 * position's facts (`context`); without them the confirmation says it is computed when the close is recorded, and no
 * words claim it was checked. When the journal recorded partial closes with a price and an amount while the trade was
 * live, the form asks for the exit of the rest and works out the one average exit the close records, with its
 * arithmetic (§60.17); otherwise the trader enters the average exit price across all partials ("Average exit price (all
 * partials)", partial closes staying journal records).
 */

export type { CloseFormMode } from "./close-model";

export interface CloseTradeFormProps {
  tradeId: string;
  mode: CloseFormMode;
  /** Why P&L must be reported (`the entry price and the size`), for the reported mode. */
  missing?: string;
  currency: string;
  tickSize: string | null;
  /** What realized R will be based on, in words. */
  basis: string;
  /** The exit can't be earlier than the entry: the bound and its time in words. */
  entered: { at: string; label: string } | null;
  display: TimeDisplay;
  nowIso: string;
  /**
   * The position's facts, its R basis and the journal's partial closes: `closeFormContext(detail)`, which the Result
   * section passes. With them the confirmation shows the outcome, net P&L and realized R before the close is recorded,
   * and known partial closes give the exit. Without them (a caller that doesn't pass it) a calculated close is still
   * confirmed first, but only the database works out its result, and the form and its confirmation say so instead of
   * claiming the result is checked.
   */
  context?: CloseFormContext;
}

const PNL_OPTIONS = [
  { value: "profit", label: "Profit" },
  { value: "loss", label: "Loss" },
  { value: "breakeven", label: "Breakeven" },
];

const NO_LEGS: CloseLegs = Object.freeze({ kind: "NONE" });
const AVERAGE_ID = "close-average";

function isPnlKind(value: string): value is PnlKind {
  return value === "profit" || value === "loss" || value === "breakeven";
}

export function CloseTradeForm({ tradeId, mode, missing, currency, tickSize, basis, entered, display, nowIso, context }: CloseTradeFormProps) {
  const notify = useNotify();
  const reported = mode === "reported";
  const legs = reported ? NO_LEGS : context?.legs ?? NO_LEGS;
  // Partial closes that add up to the whole position give the average exit; the trader checks it before closing.
  const [draft, setDraft] = useState<CloseDraft>(() => ({
    exit: legs.kind === "AVERAGE" && legs.average !== null ? onTick(legs.average, tickSize) ?? "" : "", netPnl: "", pnlKind: null, fees: "", time: { mode: "now" }, rest: "",
  }));
  /** The trader enters the average exit although the journal's partial closes would give it. */
  const [ownAverage, setOwnAverage] = useState(false);
  const action = mode === "planned" ? closePlannedTrade : closeLiveTrade;
  const { state, run, show, reset, attempt } = useTradeAction(action);
  const confirmation = useRecordConfirmation<{ fields: Record<string, string>; review: CloseReview }, CloseResult>(show);
  const pending = confirmation.pending;
  const { errorOf, touch } = useFieldErrors(state, attempt, closeFieldOf);
  const split = legs.kind === "SPLIT" && !ownAverage ? legs : null;
  const rest = (draft.rest ?? "").trim();
  const average = split && isPositiveDecimal(rest) && isAligned(rest, tickSize) ? averageExit(split, rest, tickSize) : null;
  const sizes = { quantityStep: context?.quantityStep ?? null, unit: context?.unit ?? "" };
  // Words never promise a result the confirmation can't show: what it shows decides them once it is open.
  const resultShown = pending ? pending.review.previewed : closeResultShown(mode, context);

  const update = (patch: Partial<CloseDraft>, field: string) => {
    setDraft(current => ({ ...current, ...patch }));
    touch(field);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const next = closeSubmission(draft, { mode, tickSize, currency, display, entered, split, context, basis });
    if (next.kind === "invalid") {
      run(new FormData(), next.fieldErrors as Record<string, string>);
      return;
    }
    // Nothing is recorded yet: the confirmation shows what will be, and records it only when the trader confirms.
    reset();
    confirmation.open(event, { fields: next.fields, review: next.review });
  };

  const confirm = async (): Promise<ActionState<CloseResult>> => {
    if (!pending) return { status: "error", message: TRADE_COPY.connectionLost };
    const result = await callTradeAction(action, formOf({ tradeId, ...pending.fields }));
    if (result.status === "success") {
      notify(result.message);
      keepFocusOnTrade();
    }
    return result;
  };

  const partialItems =
    legs.kind === "SPLIT" ? legs.legs.map(leg => ({ id: leg.id, text: legLabel(leg, sizes, tickSize) })) : legs.kind === "AVERAGE" ? legs.records.map(record => ({ id: record.id, text: recordLabel(record, sizes, tickSize) })) : [];

  return (
    <>
      <form noValidate onSubmit={submit} onKeyDown={submitOnModifierEnter} aria-label="Close trade" className="flex flex-col gap-4" data-form="close-trade" data-mode={mode}>
        {reported && (
          <p className="t-meta flex items-start gap-2" data-pnl="reported">
            <Info aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-3" />
            <span>
              P&L can't be calculated because {missing ?? "some entry details"} {missing?.includes(" and ") ? "are" : "is"} not recorded. Enter the net P&L from your
              platform; the exit price is optional.
            </span>
          </p>
        )}
        {reported && (
          <div className="grid gap-4 @md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <SegmentedControl
                name="close-pnl-kind"
                legend="Result"
                legendHidden={false}
                size="sm"
                options={PNL_OPTIONS}
                value={draft.pnlKind ?? ""}
                aria-describedby={errorOf("pnlKind") ? "close-pnl-kind-error" : undefined}
                onValueChange={value => isPnlKind(value) && update({ pnlKind: value, ...(value === "breakeven" ? { netPnl: "" } : {}) }, "pnlKind")}
              />
              {errorOf("pnlKind") && (
                <p id="close-pnl-kind-error" role="alert" className="field-error">
                  {errorOf("pnlKind")}
                </p>
              )}
            </div>
            {draft.pnlKind !== "breakeven" && (
              <Field
                label={draft.pnlKind === "loss" ? "Net loss" : draft.pnlKind === "profit" ? "Net profit" : "Net P&L"}
                required
                id="close-net-pnl"
                hint={`After fees, in ${currency}, without a sign.`}
                error={errorOf("netPnl")}
              >
                <DecimalInput
                  value={draft.netPnl}
                  startAdornment={draft.pnlKind === "loss" ? "−" : draft.pnlKind === "profit" ? "+" : undefined}
                  endAdornment={currency}
                  onValueChange={netPnl => update({ netPnl }, "netPnl")}
                />
              </Field>
            )}
          </div>
        )}
        {partialItems.length > 0 && (
          <section aria-labelledby="close-partials-heading" className="flex flex-col gap-1.5 rounded-control border border-border bg-surface-sunken p-3" data-partials={legs.kind.toLowerCase()}>
            <h3 id="close-partials-heading" className="text-sm font-semibold text-text">
              {CLOSE_COPY.partialsTitle}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {partialItems.map(item => (
                <li key={item.id} className="num text-text-2">
                  {item.text}
                </li>
              ))}
            </ul>
            {legs.kind === "AVERAGE" && <p className="t-meta">{AVERAGE_REASON_COPY[legs.reason]}</p>}
          </section>
        )}
        <div className="grid gap-4 @md:grid-cols-2">
          {/* The price, then (with known partial closes) the average it gives and the way to type the average instead. */}
          <div className="flex min-w-0 flex-col gap-1.5" data-average={legs.kind === "SPLIT" ? (split ? "journal" : "own") : undefined}>
            {split ? (
              <Field label={restPriceLabel(split, sizes)} required id="close-exit-price" error={errorOf("exit")}>
                <DecimalInput value={draft.rest ?? ""} aria-describedby={AVERAGE_ID} onValueChange={value => update({ rest: value }, "exit")} />
              </Field>
            ) : (
              <Field
                label={TRADE_COPY.exitPriceLabel}
                required={!reported}
                optional={reported}
                id="close-exit-price"
                hint={legs.kind === "NONE" ? TRADE_COPY.exitPriceHint : CLOSE_COPY.averageHint}
                error={errorOf("exit")}
              >
                <DecimalInput value={draft.exit} onValueChange={exit => update({ exit }, "exit")} />
              </Field>
            )}
            {split && (
              <div id={AVERAGE_ID} className="flex flex-col gap-0.5">
                {average ? (
                  <>
                    <p className="t-meta">
                      Average exit price of the whole position: <strong className="num font-semibold text-text">{formatPrice(average.price, tickSize)}</strong>
                    </p>
                    <p className="t-caption num">{averageFormula(split, rest, average, tickSize)}</p>
                  </>
                ) : (
                  <p className="t-caption">{CLOSE_COPY.averagePending}</p>
                )}
              </div>
            )}
            {legs.kind === "SPLIT" && (
              <Button type="button" variant="link" size="sm" className="self-start" onClick={() => setOwnAverage(current => !current)}>
                {split ? CLOSE_COPY.useAverage : CLOSE_COPY.useJournal}
              </Button>
            )}
          </div>
          <Field
            label="Fees"
            optional
            id="close-fees"
            hint={reported ? CLOSE_COPY.feesIncluded : "Commission and swap of the whole position. Leave empty for none."}
            error={errorOf("fees")}
          >
            <DecimalInput value={draft.fees} endAdornment={currency} onValueChange={fees => update({ fees }, "fees")} />
          </Field>
        </div>
        <TimeField
          id="close-exit-time"
          legend="Exit time"
          choice={draft.time}
          onChange={time => update({ time }, "exitedAt")}
          display={display}
          nowIso={nowIso}
          hint={entered ? `after the entry at ${entered.label}` : undefined}
          error={errorOf("exitedAt")}
        />
        <p className="t-meta" data-basis="">
          {basis}
        </p>
        <ActionMessage state={state} attempt={attempt} />
        <div className="flex flex-col-reverse gap-2 @md:flex-row @md:items-center @md:justify-between @md:gap-3">
          <p className="t-caption">{closeResultShown(mode, context) ? CLOSE_COPY.recordedOnce : CLOSE_COPY.recordedOnceWithoutResult}</p>
          <Button type="submit" icon={<LogOut aria-hidden="true" />} className="w-full @md:w-auto">
            Close trade
          </Button>
        </div>
      </form>
      {/* Outside the form: the dialog's key presses and clicks never reach the form's own handlers. */}
      <RecordConfirmDialog
        open={pending !== null}
        title={CLOSE_COPY.dialogTitle}
        description={resultShown ? CLOSE_COPY.dialogDescription : CLOSE_COPY.dialogDescriptionWithoutResult}
        confirmLabel={CLOSE_COPY.confirm}
        pendingLabel={CLOSE_COPY.pending}
        cancelLabel={CLOSE_COPY.keepEditing}
        groups={pending ? [{ title: CLOSE_COPY.recordedSection, facts: pending.review.recorded }, { title: CLOSE_COPY.resultSection, facts: pending.review.result }] : []}
        onConfirm={confirm}
        onClosed={confirmation.closed}
      />
    </>
  );
}
