"use client";

import { Ban } from "lucide-react";
import { useRef, useState } from "react";
import { setDisposition } from "@/app/actions/trades";
import { restoreFocusAfterDialog, restoreFocusWhenGone } from "@/components/accounts/focus";
import { callTradeAction, formOf } from "@/components/trade/use-trade-action";
import { Button } from "@/components/ui/button";
import { RadioCards } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useOptionalToast } from "@/components/ui/toast";
import { SKIP_REASON_REQUIRED, skipPlanDescription } from "./copy";

/**
 * "Skip…" for a plan locked on an earlier strategy day (docs/V2_ARCHITECTURE.md §2.4, §6.2): the trader says whether it
 * was skipped or cancelled, and why (`setDisposition`). The dialog states the day its slot and risk stay counted on, so
 * nothing suggests today's limits change. The row leaves Today once the page refreshes; focus then moves to the Plans
 * waiting heading instead of the page body (§13.5).
 */

type Disposition = "SKIPPED" | "CANCELLED";

export interface SkipPlanButtonProps {
  tradeId: string;
  /** "XAUUSD · Short". */
  title: string;
  /** "Oct 23": the strategy day the plan was locked on. */
  lockedOn: string;
  label: string;
  /** Id of the heading that takes focus once the row is gone. */
  focusAfterId: string;
}

export function SkipPlanButton({ tradeId, title, lockedOn, label, focusAfterId }: SkipPlanButtonProps) {
  const toast = useOptionalToast();
  const trigger = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Disposition>("SKIPPED");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = reason.trim() === "";

  const confirm = async () => {
    if (missing) {
      setTouched(true);
      return false;
    }
    const result = await callTradeAction(setDisposition, formOf({ tradeId, status, reason: reason.trim() }));
    if (result.status === "success") {
      done.current = true;
      toast?.toast({ title: result.message ?? "Trade skipped.", description: title, tone: "positive" });
    }
    return result;
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      done.current = false;
      return;
    }
    const heading = () => document.getElementById(focusAfterId);
    if (done.current) restoreFocusWhenGone(trigger.current, heading);
    else restoreFocusAfterDialog(() => (trigger.current?.isConnected ? trigger.current : heading()));
  };

  return (
    <ConfirmDialog
      trigger={
        <Button ref={trigger} type="button" variant="ghost" size="sm" icon={<Ban aria-hidden="true" />} aria-label={`Skip this trade: ${title}`}>
          {label}
        </Button>
      }
      open={open}
      onOpenChange={onOpenChange}
      title="Skip this trade?"
      description={skipPlanDescription(lockedOn)}
      confirmLabel={status === "SKIPPED" ? "Skip trade" : "Cancel plan"}
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
        <Field label="Reason" required error={touched && missing ? SKIP_REASON_REQUIRED : undefined}>
          <Textarea rows={3} maxLength={5000} value={reason} onChange={event => setReason(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
