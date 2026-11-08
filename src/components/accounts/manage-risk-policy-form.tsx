"use client";

import Decimal from "decimal.js";
import { TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { createRiskPolicyVersion } from "@/app/actions/accounts";
import { formatDecimal } from "@/domain/format";
import { Button } from "@/components/ui/button";
import { RadioCards, SegmentedControl } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionFeedback } from "./action-feedback";
import { IMMEDIATE_COPY, IMMEDIATE_OPTION_COPY, NEXT_DAY_OPTION_COPY } from "./copy";
import { type FieldRule, MONEY_COPY } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

/**
 * Create a risk policy version (spec §3.10, §14.9): next trading day by default; an immediate version (in effect from
 * now until a newer one, not for today only) needs a reason of at least 5 characters. Inline notes compare the entered
 * minimum RR with the strategy's documented minimum and the default risk with the maximum, exactly (Decimal), before
 * the server validates again.
 */

export interface RiskPolicyDefaults {
  maxRiskPercent: string;
  defaultRiskPercent: string;
  maxDailyTrades: number;
  minRR: string;
  rrPolicy: "BLOCK" | "WARN";
  newsPolicy: "BLOCK" | "WARN";
  dailyRiskCap: string | null;
  dailyLossCap: string | null;
}

const MIN_REASON = 5;
const POLICY_RULES: Readonly<Record<string, FieldRule>> = {
  defaultRiskPercent: { kind: "decimal", max: "100", message: "Default risk must be more than 0% and not above the maximum." },
  maxRiskPercent: { kind: "decimal", max: "100", message: "Maximum risk must be more than 0% and at most 100%, with up to 8 decimals." },
  maxDailyTrades: { kind: "whole", min: 1, max: 100, message: "Trades per day must be a whole number from 1 to 100." },
  minRR: { kind: "decimal", max: "100", message: "Minimum RR must be more than 0 and at most 100, with up to 8 decimals." },
  dailyRiskCap: { kind: "money", optional: true, message: MONEY_COPY("Daily risk cap") },
  dailyLossCap: { kind: "money", optional: true, message: MONEY_COPY("Daily loss limit") },
};
const POLICY_OPTIONS = [
  { value: "BLOCK", label: "Block" },
  { value: "WARN", label: "Warn" },
];

/** A positive decimal, else null (incomplete input is not judged). */
function decimalOrNull(value: string): Decimal | null {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const number = new Decimal(value.trim());
  return number.gt(0) ? number : null;
}

export function RiskPolicyForm({ accountId, currency, defaults, strategyMinimum }: { accountId: string; currency: string; defaults: RiskPolicyDefaults; strategyMinimum: string | null }) {
  const [maxRisk, setMaxRisk] = useState(formatDecimal(defaults.maxRiskPercent));
  const [defaultRisk, setDefaultRisk] = useState(formatDecimal(defaults.defaultRiskPercent));
  const [minRR, setMinRR] = useState(formatDecimal(defaults.minRR));
  const [immediate, setImmediate] = useState(false);
  const [reason, setReason] = useState("");
  const [generation, setGeneration] = useState(0);
  const { state, pending, run, feedbackKey } = useAccountAction(createRiskPolicyVersion, () => {
    setImmediate(false);
    setReason("");
    setGeneration(value => value + 1);
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("accountId", accountId);
    if (immediate) form.set("immediate", "on");
    else form.delete("reason");
    run(form, POLICY_RULES);
  };

  const max = decimalOrNull(maxRisk);
  const fallback = decimalOrNull(defaultRisk);
  const defaultAboveMax = max !== null && Boolean(fallback?.gt(max));
  const rr = decimalOrNull(minRR);
  const belowStrategy = strategyMinimum !== null && Boolean(rr?.lt(strategyMinimum));
  const error = (key: string) => fieldError(state, key);
  const unit = (text: string) => <span aria-hidden="true">{text}</span>;

  return (
    <form key={`form-${generation}`} noValidate onSubmit={submit} className="flex flex-col gap-5" aria-label="Create a risk plan version" aria-busy={pending}>
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Default risk per trade"
          required
          error={error("defaultRiskPercent") ?? (defaultAboveMax ? "The default can't be above the maximum." : undefined)}
          hint="Preselected on new plans."
        >
          <DecimalInput name="defaultRiskPercent" value={defaultRisk} onValueChange={setDefaultRisk} endAdornment={unit("%")} disabled={pending} />
        </Field>
        <Field label="Maximum risk per trade" required error={error("maxRiskPercent")} hint="Plans above it are blocked.">
          <DecimalInput name="maxRiskPercent" value={maxRisk} onValueChange={setMaxRisk} endAdornment={unit("%")} disabled={pending} />
        </Field>
        <Field label="Trades per day" required error={error("maxDailyTrades")} hint="Planned and live-first trades both use a slot.">
          <Input name="maxDailyTrades" defaultValue={String(defaults.maxDailyTrades)} inputMode="numeric" autoComplete="off" disabled={pending} />
        </Field>
        <div className="flex flex-col gap-2">
          <Field
            label="Minimum RR"
            required
            error={error("minRR")}
            hint={strategyMinimum ? `The strategy documents ${formatDecimal(strategyMinimum)}R.` : undefined}
          >
            <DecimalInput name="minRR" value={minRR} onValueChange={setMinRR} endAdornment={unit("R")} disabled={pending} />
          </Field>
          {belowStrategy && strategyMinimum && (
            <p className="flex items-start gap-1.5 text-sm text-warn" role="status">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none" />
              Below the strategy's documented {formatDecimal(strategyMinimum)}R minimum.
            </p>
          )}
        </div>
        <SegmentedControl name="rrPolicy" legend="Below the minimum RR" legendHidden={false} options={POLICY_OPTIONS} defaultValue={defaults.rrPolicy} disabled={pending} />
        <SegmentedControl name="newsPolicy" legend="During restricted news" legendHidden={false} options={POLICY_OPTIONS} defaultValue={defaults.newsPolicy} disabled={pending} />
        <Field label="Daily risk cap" optional error={error("dailyRiskCap")} hint="Total risk of the day's trades. Empty means no cap.">
          <DecimalInput name="dailyRiskCap" defaultValue={defaults.dailyRiskCap ? formatDecimal(defaults.dailyRiskCap) : ""} endAdornment={unit(currency)} disabled={pending} />
        </Field>
        <Field label="Daily loss limit" optional error={error("dailyLossCap")} hint="Realized and external losses plus open risk. Empty means no limit.">
          <DecimalInput name="dailyLossCap" defaultValue={defaults.dailyLossCap ? formatDecimal(defaults.dailyLossCap) : ""} endAdornment={unit(currency)} disabled={pending} />
        </Field>
      </div>

      <RadioCards
        name="timing"
        legend="When it takes effect"
        value={immediate ? "immediate" : "next-day"}
        onValueChange={value => setImmediate(value === "immediate")}
        disabled={pending}
        options={[
          { value: "next-day", label: "Next trading day", description: NEXT_DAY_OPTION_COPY },
          { value: "immediate", label: "Immediately", description: IMMEDIATE_OPTION_COPY },
        ]}
      />
      {immediate && (
        <Field label="Reason for the immediate change" required error={error("immediateReason")} hint={`${IMMEDIATE_COPY} At least ${MIN_REASON} characters.`}>
          <Textarea name="reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={2} disabled={pending} />
        </Field>
      )}
      <div>
        <Button type="submit" loading={pending} loadingText="Creating version…">
          {immediate ? "Create and apply now" : "Create version"}
        </Button>
      </div>
    </form>
  );
}
