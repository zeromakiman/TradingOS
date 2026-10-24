"use client";

import { Info, LogOut } from "lucide-react";
import { type FormEvent, useState } from "react";
import { closeLiveTrade, closePlannedTrade } from "@/app/actions/trades";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import type { TimeDisplay } from "@/domain/time-display";
import { ActionMessage, useNotify } from "./action-message";
import { TRADE_COPY } from "./copy";
import { type CloseDraft, closeFieldOf, type PnlKind, validateClose } from "./form-model";
import { keepFocusOnTrade } from "./reveal";
import { TimeField } from "./time-field";
import { useFieldErrors } from "./use-field-errors";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Close trade (docs/V2_ARCHITECTURE.md §3.4–3.6, §8.2): one exit for the whole position, labelled "Average exit price
 * (all partials)" (partial closes stay journal records). A planned trade sends exit, time and fees (FULL_CLOSE_V1,
 * R = net P&L ÷ locked risk). A live-first trade sends the exit price when its P&L can be calculated from the recorded
 * contract, entry and size, and otherwise the net P&L the trader reports, whose sign is chosen explicitly (Profit,
 * Loss or Breakeven), so a loss is never recorded as a profit by default. The close is recorded once.
 */

export type CloseFormMode = "planned" | "calculated" | "reported";

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
}

const PNL_OPTIONS = [
  { value: "profit", label: "Profit" },
  { value: "loss", label: "Loss" },
  { value: "breakeven", label: "Breakeven" },
];

function isPnlKind(value: string): value is PnlKind {
  return value === "profit" || value === "loss" || value === "breakeven";
}

export function CloseTradeForm({ tradeId, mode, missing, currency, tickSize, basis, entered, display, nowIso }: CloseTradeFormProps) {
  const notify = useNotify();
  const [draft, setDraft] = useState<CloseDraft>({ exit: "", netPnl: "", pnlKind: null, fees: "", time: { mode: "now" } });
  const action = mode === "planned" ? closePlannedTrade : closeLiveTrade;
  const { state, pending, run, attempt } = useTradeAction(action, result => {
    notify(result.message);
    keepFocusOnTrade();
  });
  const { errorOf, touch } = useFieldErrors(state, attempt, closeFieldOf);
  const reported = mode === "reported";

  const update = (patch: Partial<CloseDraft>, field: string) => {
    setDraft(current => ({ ...current, ...patch }));
    touch(field);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const checked = validateClose(draft, {
      mode, tickSize, display,
      enteredAt: entered ? { instant: entered.at, message: `The exit time must be after the entry (${entered.label}).` } : null,
    });
    if (!checked.ok) {
      run(new FormData(), checked.fieldErrors as Record<string, string>);
      return;
    }
    run(formOf({ tradeId, ...checked.fields }));
  };

  return (
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
              disabled={pending}
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
                readOnly={pending}
                startAdornment={draft.pnlKind === "loss" ? "−" : draft.pnlKind === "profit" ? "+" : undefined}
                endAdornment={currency}
                onValueChange={netPnl => update({ netPnl }, "netPnl")}
              />
            </Field>
          )}
        </div>
      )}
      <div className="grid gap-4 @md:grid-cols-2">
        <Field label={TRADE_COPY.exitPriceLabel} required={!reported} optional={reported} id="close-exit-price" hint={TRADE_COPY.exitPriceHint} error={errorOf("exit")}>
          <DecimalInput value={draft.exit} readOnly={pending} onValueChange={exit => update({ exit }, "exit")} />
        </Field>
        <Field
          label="Fees"
          optional
          id="close-fees"
          hint={reported ? "For your records: the net P&L already includes them." : "Commission and swap of the whole position. Leave empty for none."}
          error={errorOf("fees")}
        >
          <DecimalInput value={draft.fees} readOnly={pending} endAdornment={currency} onValueChange={fees => update({ fees }, "fees")} />
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
        disabled={pending}
      />
      <p className="t-meta" data-basis="">
        {basis}
      </p>
      <ActionMessage state={state} attempt={attempt} />
      <div className="flex flex-col-reverse gap-2 @md:flex-row @md:items-center @md:justify-between @md:gap-3">
        <p className="t-caption">Recorded once: the close can't be changed later.</p>
        <Button type="submit" icon={<LogOut aria-hidden="true" />} loading={pending} loadingText="Closing…" className="w-full @md:w-auto">
          Close trade
        </Button>
      </div>
    </form>
  );
}
