"use client";

import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { addExternalLoss, removeExternalLoss } from "@/app/actions/accounts";
import { idleState } from "@/app/actions/state";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOptionalToast } from "@/components/ui/toast";
import { ActionFeedback } from "./action-feedback";
import { ADD_EXTERNAL_LOSS, EXTERNAL_LOSS_HELPER, EXTERNAL_LOSS_SYNC_NOTE } from "./copy";
import { type FieldRule, MONEY_COPY } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

const LOSS_RULES: Readonly<Record<string, FieldRule>> = {
  amount: { kind: "money", message: MONEY_COPY("Amount") },
  note: { kind: "text", max: 500, optional: true, message: "Keep the note to 500 characters." },
};

/**
 * External realized losses (spec §3.9, §8.4): losses of trades that are not in Trading OS, added to today's daily
 * loss total. Removing one is soft and audited: it stays in the history with its reason.
 */

export function AddExternalLossForm({ accountId, currency }: { accountId: string; currency: string }) {
  const requestKey = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const { state, pending, run, feedbackKey } = useAccountAction<{ entryId: string }>(addExternalLoss, () => {
    requestKey.current = null;
    setGeneration(value => value + 1);
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    requestKey.current ??= globalThis.crypto.randomUUID();
    form.set("accountId", accountId);
    form.set("requestKey", requestKey.current);
    run(form, LOSS_RULES);
  };
  return (
    <div className="flex flex-col gap-4">
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <form key={`form-${generation}`} noValidate onSubmit={submit} className="flex flex-col gap-4" aria-label={ADD_EXTERNAL_LOSS} aria-busy={pending}>
        <Field label="Amount" required error={fieldError(state, "amount")} hint="A positive amount: the loss after fees.">
          <DecimalInput name="amount" endAdornment={<span aria-hidden="true">{currency}</span>} disabled={pending} />
        </Field>
        <Field label="Note" optional error={fieldError(state, "note")} hint="Where the loss happened, for example the platform or account.">
          <Input name="note" maxLength={500} autoComplete="off" disabled={pending} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" icon={<Plus aria-hidden="true" />} loading={pending} loadingText="Adding…">
            {ADD_EXTERNAL_LOSS}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function ExternalLossHelp() {
  return (
    <div className="flex flex-col gap-1">
      <p className="t-meta">{EXTERNAL_LOSS_HELPER}</p>
      <p className="t-caption">{EXTERNAL_LOSS_SYNC_NOTE}</p>
    </div>
  );
}

export function RemoveExternalLossButton({ entryId, amountLabel }: { entryId: string; amountLabel: string }) {
  const toast = useOptionalToast();
  const [reason, setReason] = useState("");
  const confirm = async () => {
    const form = new FormData();
    form.set("entryId", entryId);
    if (reason.trim()) form.set("reason", reason.trim());
    const result = await removeExternalLoss(idleState, form);
    if (result.status === "success") toast?.toast({ title: result.message ?? "External loss removed.", tone: "positive" });
    return result;
  };
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" icon={<Trash2 aria-hidden="true" />} aria-label={`Remove the external loss of ${amountLabel}`}>
          Remove
        </Button>
      }
      title={`Remove the external loss of ${amountLabel}?`}
      description="It no longer counts toward today's losses. The entry and your reason stay in the history."
      confirmLabel="Remove loss"
      pendingLabel="Removing…"
      tone="danger"
      onConfirm={confirm}
      onOpenChange={open => {
        if (!open) setReason("");
      }}
    >
      <Field label="Reason" optional hint="Kept with the entry, for example “entered twice”.">
        <Textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={2} />
      </Field>
    </ConfirmDialog>
  );
}
