"use client";

import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { createTradingAccount } from "@/app/actions/accounts";
import type { AccountType } from "@/domain/account-metrics";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { ActionFeedback } from "./action-feedback";
import { ACCOUNT_CURRENCIES, ACCOUNT_TYPE_HINTS, ACCOUNT_TYPES, accountTypeLabel, PLATFORM_HINT, PLATFORMS, platformLabel } from "./copy";
import { type FieldRule, MONEY_COPY } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

/**
 * Create a trading account (docs/V2_ARCHITECTURE.md §3.2, §14.12). Used by /accounts/new and by the Today onboarding
 * card, so it takes no props: on /accounts/new a created account opens its dashboard; anywhere else the page refreshes
 * (the action revalidates the whole app, so onboarding gives way to the normal screen).
 *
 * The request key is created on the first submission and kept until one succeeds, so a retry after a dropped
 * connection replays the same request instead of creating a second account.
 */

export const DEFAULT_PLAN_NOTE =
  "Every new account starts with the ICT V1.0 strategy and Risk Plan V1.0: 0.50% risk per trade, 2 trades per day and a 3.00R minimum (below it, plans are blocked). You can change the risk plan later in Manage.";

const CREATE_RULES: Readonly<Record<string, FieldRule>> = {
  name: { kind: "text", max: 100, message: "Name the account (1 to 100 characters)." },
  broker: { kind: "text", max: 100, optional: true, message: "Keep the broker name to 100 characters." },
  balance: { kind: "money", message: MONEY_COPY("Balance") },
  startingBalance: { kind: "money", optional: true, message: MONEY_COPY("Starting balance") },
};
const EQUITY_RULE: Readonly<Record<string, FieldRule>> = { equity: { kind: "money", message: MONEY_COPY("Equity") } };

function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

function newRequestKey(): string {
  return globalThis.crypto.randomUUID();
}

export function CreateAccountForm() {
  const router = useRouter();
  const pathname = usePathname();
  const requestKey = useRef<string | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [accountType, setAccountType] = useState<AccountType>("EVALUATION");
  const [balance, setBalance] = useState("");
  const [equitySame, setEquitySame] = useState(true);
  const { state, pending, run, feedbackKey } = useAccountAction<{ accountId: string }>(createTradingAccount, result => {
    requestKey.current = null;
    const accountId = result.data?.accountId;
    if (pathname?.startsWith("/accounts") && accountId) router.push(`/accounts/${accountId}`);
    else router.refresh();
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    requestKey.current ??= newRequestKey();
    form.set("requestKey", requestKey.current);
    if (equitySame) form.set("equity", String(form.get("balance") ?? ""));
    run(form, equitySame ? CREATE_RULES : { ...CREATE_RULES, ...EQUITY_RULE });
  };

  const error = (field: string) => fieldError(state, field);
  const unit = <span aria-hidden="true">{currency}</span>;

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-5" aria-label="Create trading account" aria-busy={pending}>
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <Field label="Account name" required error={error("name")} hint="How the account appears everywhere, for example “FTMO 100K”.">
        <Input name="name" maxLength={100} autoComplete="off" disabled={pending} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account type" required error={error("accountType")} hint={ACCOUNT_TYPE_HINTS[accountType]}>
          <Select name="accountType" value={accountType} onChange={event => isAccountType(event.target.value) && setAccountType(event.target.value)} disabled={pending}>
            {ACCOUNT_TYPES.map(type => (
              <option key={type} value={type}>
                {accountTypeLabel(type)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency" required error={error("currency")} hint="Fixed once created. Money is never converted between accounts.">
          <Select name="currency" value={currency} onChange={event => setCurrency(event.target.value)} disabled={pending}>
            {ACCOUNT_CURRENCIES.map(option => (
              <option key={option.code} value={option.code}>
                {option.code} — {option.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Broker or prop firm" optional error={error("broker")}>
          <Input name="broker" maxLength={100} autoComplete="off" disabled={pending} />
        </Field>
        <Field label="Platform" required error={error("platform")} hint={PLATFORM_HINT}>
          <Select name="platform" defaultValue="MANUAL" disabled={pending}>
            {PLATFORMS.map(platform => (
              <option key={platform} value={platform}>
                {platformLabel(platform)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="border-t border-border pt-5">
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 font-semibold text-text">Account values</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Current balance" required error={error("balance")} hint="What your broker shows now, without open positions.">
            <DecimalInput name="balance" value={balance} onValueChange={setBalance} endAdornment={unit} disabled={pending} />
          </Field>
          <Field label="Starting balance" optional error={error("startingBalance")} hint="What the account started with. Empty uses the current balance.">
            <DecimalInput name="startingBalance" endAdornment={unit} disabled={pending} />
          </Field>
        </div>
        <Checkbox
          label="Equity equals balance"
          description="No open positions right now. Untick to enter equity separately."
          checked={equitySame}
          onChange={event => setEquitySame(event.target.checked)}
          disabled={pending}
        />
        {!equitySame && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current equity" required error={error("equity")} hint="Balance plus the open positions' floating result.">
              <DecimalInput name="equity" endAdornment={unit} disabled={pending} />
            </Field>
          </div>
        )}
        {equitySame && error("equity") && <p className="field-error">{error("equity")}</p>}
      </fieldset>
      </div>

      <p className="t-meta">{DEFAULT_PLAN_NOTE}</p>
      {currency !== "USD" && (
        <p className="t-meta">EURUSD and GBPUSD contracts are added only to USD accounts. Add the instruments you trade in Manage → Instruments.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} loadingText="Creating account…">
          Create trading account
        </Button>
      </div>
    </form>
  );
}
