"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useId, useState } from "react";
import { discardDraft, duplicateDraft, lockPlan, reopenReview, setDisposition } from "@/app/actions/trades";
import { RadioCards } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useNotify } from "./action-message";
import { skipDialogCopy } from "./copy";
import type { LockSummary } from "./model";
import { keepFocusOnTrade } from "./reveal";
import { callTradeAction, formOf } from "./use-trade-action";

/**
 * Confirmations of the trade page (docs/V2_ARCHITECTURE.md §2.4, §8.1): lock (what becomes immutable and what is
 * reserved), discard, skip or cancel, reopen review and duplicate. Each runs one §12.2 action; a refusal keeps the
 * dialog open with the action's own words, and a success closes it while the page refreshes to the new state. Every
 * dialog works with its own trigger or controlled from the overflow menu.
 */

interface DialogControl {
  /** The element that opens the dialog (created in this client tree, so Radix can slot onto it). */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Called when the action succeeded, before the dialog closes. A dialog controlled from the overflow menu uses it to
   * tell a confirmed close (focus then follows the new state of the trade) from a cancelled one (focus returns to the
   * menu button).
   */
  onConfirmed?: () => void;
}

function DialogList({ title, items }: { title: string; items: readonly string[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h3 id={id} className="text-[0.8125rem] font-semibold text-text">
        {title}
      </h3>
      <ul className="t-meta flex list-disc flex-col gap-0.5 pl-5">
        {items.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function LockPlanDialog({ tradeId, expectedRevision, summary, onConfirmed, ...control }: DialogControl & { tradeId: string; expectedRevision: number; summary: LockSummary }) {
  const notify = useNotify();
  const confirm = async () => {
    const result = await callTradeAction(lockPlan, formOf({ tradeId, expectedRevision: String(expectedRevision) }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      keepFocusOnTrade();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      title="Lock this plan?"
      description="Locking re-checks the plan on the server and seals it. If anything changed since the last check, nothing is locked and the reasons are shown."
      confirmLabel="Lock plan"
      pendingLabel="Locking…"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <DialogList title="Becomes immutable" items={summary.immutable} />
        <DialogList title="Reserved today" items={summary.reserved} />
        <p className="t-caption">{summary.stillOpen}</p>
      </div>
    </ConfirmDialog>
  );
}

export function DiscardDialog({ tradeId, requestKey, onConfirmed, ...control }: DialogControl & { tradeId: string; requestKey: string }) {
  const notify = useNotify();
  const [reason, setReason] = useState("");
  const confirm = async () => {
    const result = await callTradeAction(discardDraft, formOf({ tradeId, reason: reason.trim(), requestKey }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      keepFocusOnTrade();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      tone="danger"
      title="Discard this draft?"
      description="It leaves your plans and can't be locked. Its revisions, risk checks, notes and screenshots stay in the history."
      confirmLabel="Discard draft"
      pendingLabel="Discarding…"
      onConfirm={confirm}
    >
      <Field label="Reason" optional hint="Kept with the draft's history, for example why the idea no longer applies.">
        <Textarea rows={2} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

type Disposition = "SKIPPED" | "CANCELLED";

/**
 * Skip or cancel a locked plan. The title and the confirm button follow the choice, and the button that closes the
 * dialog says "Keep plan", so it never reads like the cancellation itself. `slotNote` names the trading day whose
 * trade limit the plan keeps counting toward (`skipSlotNote`).
 */
export function SkipTradeDialog({ tradeId, slotNote, onConfirmed, ...control }: DialogControl & { tradeId: string; slotNote: string }) {
  const notify = useNotify();
  const [status, setStatus] = useState<Disposition>("SKIPPED");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = reason.trim() === "";
  const copy = skipDialogCopy(status, slotNote);
  const confirm = async () => {
    if (missing) {
      setTouched(true);
      return false;
    }
    const result = await callTradeAction(setDisposition, formOf({ tradeId, status, reason: reason.trim() }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      keepFocusOnTrade();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      cancelLabel={copy.cancelLabel}
      pendingLabel="Saving…"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <RadioCards
          name="disposition"
          legend="What happened?"
          value={status}
          onValueChange={value => setStatus(value === "CANCELLED" ? "CANCELLED" : "SKIPPED")}
          options={[
            { value: "SKIPPED", label: "Skipped", description: "I chose not to take it." },
            { value: "CANCELLED", label: "Cancelled", description: "The plan no longer applies, for example the setup was invalidated before entry." },
          ]}
        />
        <Field label="Reason" required error={touched && missing ? "Add a reason: it stays with the plan." : undefined}>
          <Textarea rows={3} maxLength={5000} value={reason} onChange={event => setReason(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

export function ReopenReviewDialog({ tradeId, requestKey, onConfirmed, ...control }: DialogControl & { tradeId: string; requestKey: string }) {
  const notify = useNotify();
  const [reason, setReason] = useState("");
  const confirm = async () => {
    const result = await callTradeAction(reopenReview, formOf({ tradeId, reason: reason.trim(), requestKey }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      keepFocusOnTrade();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      title="Reopen the review?"
      description="The trade returns to Closed · review pending. Your tags, lessons and AI reviews stay."
      confirmLabel="Reopen review"
      pendingLabel="Reopening…"
      onConfirm={confirm}
    >
      <Field label="Reason" optional hint="Kept in the timeline, for example what you want to look at again.">
        <Textarea rows={2} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

/** `notes`: what duplicating copies, in words (`duplicateNotes`). */
export function DuplicateDialog({ tradeId, requestKey, notes, onConfirmed, ...control }: DialogControl & { tradeId: string; requestKey: string; notes: readonly string[] }) {
  const notify = useNotify();
  const router = useRouter();
  const confirm = async () => {
    const result = await callTradeAction(duplicateDraft, formOf({ tradeId, requestKey }));
    if (result.status === "success" && result.data) {
      onConfirmed?.();
      notify(result.message);
      router.push(`/trades/${result.data.tradeId}`);
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      title="Duplicate as a new draft?"
      description="The new draft gets the same plan values and its own free risk check. This trade doesn't change."
      confirmLabel="Duplicate draft"
      pendingLabel="Duplicating…"
      onConfirm={confirm}
    >
      <ul className="t-meta flex list-disc flex-col gap-0.5 pl-5">
        {notes.map(note => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
