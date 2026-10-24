"use client";

import { Ban, CircleCheck, Lightbulb } from "lucide-react";
import { completeReview } from "@/app/actions/trades";
import { Button, buttonClasses } from "@/components/ui/button";
import { ActionMessage, useNotify } from "./action-message";
import { focusComposer, keepFocusOnTrade, TRADE_TARGETS } from "./reveal";
import { SkipTradeDialog } from "./trade-dialogs";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Review controls of the trade page (docs/V2_ARCHITECTURE.md §2.2, §2.4, §14.4): Mark reviewed (the trader decides;
 * an AI review alone never marks a trade reviewed; the header carries Reopen review), "Add a lesson" (the journal
 * composer on its Lesson kind) and "Skip this trade…" next to the record-entry form. Triggers are created here, in
 * the client tree, so the dialogs can slot onto them.
 */

export function MarkReviewedButton({ tradeId, requestKey }: { tradeId: string; requestKey: string }) {
  const notify = useNotify();
  const { state, pending, run, attempt } = useTradeAction(completeReview, result => {
    notify(result.message);
    keepFocusOnTrade();
  });
  return (
    <div className="flex flex-col gap-2">
      <ActionMessage state={state} attempt={attempt} />
      <Button variant="secondary" icon={<CircleCheck aria-hidden="true" />} loading={pending} loadingText="Saving…" onClick={() => run(formOf({ tradeId, requestKey }))}>
        Mark reviewed
      </Button>
    </div>
  );
}

/** Opens the journal composer on the Lesson kind; without JavaScript it jumps to the journal. */
export function AddLessonButton() {
  return (
    <a
      href={`#${TRADE_TARGETS.journal}`}
      className={buttonClasses({ variant: "secondary", size: "sm" })}
      onClick={event => {
        if (focusComposer("LESSON")) event.preventDefault();
      }}
    >
      <Lightbulb aria-hidden="true" />
      Add a lesson
    </a>
  );
}

/** `slotNote`: the trading day whose trade limit the plan keeps counting toward (`skipSlotNote`). */
export function SkipTradeButton({ tradeId, slotNote }: { tradeId: string; slotNote: string }) {
  return (
    <SkipTradeDialog
      tradeId={tradeId}
      slotNote={slotNote}
      trigger={
        <Button variant="ghost" size="sm" icon={<Ban aria-hidden="true" />}>
          Skip this trade…
        </Button>
      }
    />
  );
}
