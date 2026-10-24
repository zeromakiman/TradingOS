"use client";

import { CheckCheck } from "lucide-react";
import { type FormEvent, useRef } from "react";
import { confirmAccountValuesUnchanged, recordAccountValues } from "@/app/actions/accounts";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { useOptionalToast } from "@/components/ui/toast";
import { ActionFeedback } from "./action-feedback";
import { CONFIRM_UNCHANGED, UPDATE_VALUES } from "./copy";
import { restoreFocusWhenGone } from "./focus";
import { type FieldRule, MONEY_COPY } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

const VALUE_RULES: Readonly<Record<string, FieldRule>> = {
  balance: { kind: "money", message: MONEY_COPY("Balance") },
  equity: { kind: "money", message: MONEY_COPY("Equity") },
};

/**
 * Account values (spec §8.4): one click confirms the values shown as today's ("Confirm unchanged"); the form records
 * new balance and equity. The confirmation names the values it saw, so it is refused when newer ones exist.
 */

export interface ConfirmUnchangedButtonProps {
  accountId: string;
  observationId: string;
  variant?: "primary" | "secondary";
  /**
   * Id of a stable element of the surrounding section (its title). The button is gone once today's values exist, so
   * focus moves there after a confirmation instead of falling back to the page body (§13.5).
   */
  focusAfter?: string;
}

export function ConfirmUnchangedButton({ accountId, observationId, variant = "primary", focusAfter }: ConfirmUnchangedButtonProps) {
  const toast = useOptionalToast();
  const control = useRef<HTMLDivElement>(null);
  const { state, pending, run } = useAccountAction(confirmAccountValuesUnchanged, result => {
    toast?.toast({ title: result.message ?? "Balance confirmed for today.", tone: "positive" });
    if (focusAfter) restoreFocusWhenGone(control.current, () => document.getElementById(focusAfter));
  });
  const confirm = () => {
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("observationId", observationId);
    run(form);
  };
  return (
    <div ref={control} className="flex flex-col gap-2">
      <div>
        <Button type="button" variant={variant} icon={<CheckCheck aria-hidden="true" />} loading={pending} loadingText="Confirming…" onClick={confirm}>
          {CONFIRM_UNCHANGED}
        </Button>
      </div>
      {state.status === "error" && <ActionFeedback state={state} />}
    </div>
  );
}

export function UpdateValuesForm({ accountId, currency, balance, equity }: { accountId: string; currency: string; balance: string | null; equity: string | null }) {
  const { state, pending, run, feedbackKey } = useAccountAction(recordAccountValues);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("accountId", accountId);
    run(form, VALUE_RULES);
  };
  const unit = <span aria-hidden="true">{currency}</span>;
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4" aria-label={UPDATE_VALUES} aria-busy={pending}>
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Balance" required error={fieldError(state, "balance")} hint="Closed-trade balance your broker shows now.">
          <DecimalInput name="balance" defaultValue={balance ?? ""} endAdornment={unit} disabled={pending} />
        </Field>
        <Field label="Equity" required error={fieldError(state, "equity")} hint="Balance plus the floating result of open positions.">
          <DecimalInput name="equity" defaultValue={equity ?? ""} endAdornment={unit} disabled={pending} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" loading={pending} loadingText="Saving…">
          {UPDATE_VALUES}
        </Button>
      </div>
    </form>
  );
}
