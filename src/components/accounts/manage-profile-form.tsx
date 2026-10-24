"use client";

import { type FormEvent, useState } from "react";
import { updateProfile } from "@/app/actions/accounts";
import type { AccountPlatform, AccountType } from "@/domain/account-metrics";
import { formatDecimal } from "@/domain/format";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { ActionFeedback } from "./action-feedback";
import { ACCOUNT_TYPE_HINTS, ACCOUNT_TYPES, accountTypeLabel, PLATFORM_HINT, PLATFORMS, platformLabel } from "./copy";
import { type FieldRule, MONEY_COPY } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

const PROFILE_RULES: Readonly<Record<string, FieldRule>> = {
  displayName: { kind: "text", max: 100, message: "Name the account (1 to 100 characters)." },
  broker: { kind: "text", max: 100, optional: true, message: "Keep the broker name to 100 characters." },
  startingBalance: { kind: "money", optional: true, message: MONEY_COPY("Starting balance") },
};

/** Profile of a trading account (spec §3.2 update_account_profile): every save appends a revision; history stays. */

export interface ProfileFormProps {
  accountId: string;
  currency: string;
  name: string;
  broker: string | null;
  platform: AccountPlatform;
  type: AccountType;
  startingBalance: string | null;
}

export function ProfileForm({ accountId, currency, name, broker, platform, type, startingBalance }: ProfileFormProps) {
  const [accountType, setAccountType] = useState<AccountType>(type);
  const { state, pending, run, feedbackKey } = useAccountAction(updateProfile);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("accountId", accountId);
    run(form, PROFILE_RULES);
  };
  const error = (key: string) => fieldError(state, key);
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-5" aria-label="Account profile" aria-busy={pending}>
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <Field label="Account name" required error={error("displayName")}>
        <Input name="displayName" defaultValue={name} maxLength={100} autoComplete="off" disabled={pending} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account type" required error={error("accountType")} hint={ACCOUNT_TYPE_HINTS[accountType]}>
          <Select
            name="accountType"
            value={accountType}
            onChange={event => {
              const next = ACCOUNT_TYPES.find(item => item === event.target.value);
              if (next) setAccountType(next);
            }}
            disabled={pending}
          >
            {ACCOUNT_TYPES.map(item => (
              <option key={item} value={item}>
                {accountTypeLabel(item)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Broker or prop firm" optional error={error("broker")}>
          <Input name="broker" defaultValue={broker ?? ""} maxLength={100} autoComplete="off" disabled={pending} />
        </Field>
        <Field label="Platform" required error={error("platform")} hint={PLATFORM_HINT}>
          <Select name="platform" defaultValue={platform} disabled={pending}>
            {PLATFORMS.map(item => (
              <option key={item} value={item}>
                {platformLabel(item)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Starting balance"
          optional
          error={error("startingBalance")}
          hint="Used for “Balance from trades”. Leave empty if you don't know it; Trading OS never estimates one."
        >
          <DecimalInput name="startingBalance" defaultValue={startingBalance === null ? "" : formatDecimal(startingBalance)} endAdornment={<span aria-hidden="true">{currency}</span>} disabled={pending} />
        </Field>
      </div>
      <p className="t-meta">Currency: {currency}. It is fixed when the account is created.</p>
      <div>
        <Button type="submit" loading={pending} loadingText="Saving…">
          Save profile
        </Button>
      </div>
    </form>
  );
}
