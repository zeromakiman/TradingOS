"use client";

import { Ban, CircleCheck, Lightbulb } from "lucide-react";
import { useEffect, useRef } from "react";
import { completeReview } from "@/app/actions/trades";
import { Button, buttonClasses } from "@/components/ui/button";
import { ActionMessage, useNotify } from "./action-message";
import type { TagValues } from "./form-model";
import { focusComposer, keepFocusOnTrade, TRADE_TARGETS } from "./reveal";
import { useUnsavedTags, withTagFields } from "./tags-form";
import { SkipTradeDialog } from "./trade-dialogs";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Review controls of the trade page (docs/V2_ARCHITECTURE.md §2.2, §2.4, §14.4): Mark reviewed (the trader decides;
 * an AI review alone never marks a trade reviewed; the header carries Reopen review), "Add a lesson" (the journal
 * composer on its Lesson kind) and "Skip this trade…" next to the record-entry form. Triggers are created here, in
 * the client tree, so the dialogs can slot onto them.
 */

const MARK_REVIEWED = "Mark reviewed";
/** Mark reviewed while the tags form holds unsaved changes: it saves them first, in the same action. */
const SAVE_TAGS_AND_MARK_REVIEWED = "Save tags and mark reviewed";

/**
 * The `completeReview` form: with `unsaved` tags, `saveTags` and the `setTags` fields, so the action saves them before
 * it marks the trade reviewed (and marks nothing when they can't be saved).
 */
export function markReviewedForm(tradeId: string, requestKey: string, unsaved: TagValues | null): FormData {
  const form = formOf({ tradeId, requestKey });
  if (!unsaved) return form;
  form.set("saveTags", "true");
  return withTagFields(form, unsaved);
}

export function MarkReviewedButton({ tradeId, requestKey }: { tradeId: string; requestKey: string }) {
  const notify = useNotify();
  const tags = useUnsavedTags();
  // The tag set this click saves first; the tags form shows it as saved once the action succeeds.
  const sent = useRef<TagValues | null>(null);
  const { state, pending, run, attempt } = useTradeAction(completeReview, result => {
    if (sent.current) tags?.confirm(sent.current);
    notify(result.message);
    keepFocusOnTrade();
  });
  // While this click saves the form's changes, the form takes no more (they would not be part of the save). Released on
  // unmount as well: a completed review commits together with the refreshed page, which no longer shows this button.
  const setTagsBusy = tags?.setBusy;
  useEffect(() => {
    if (!setTagsBusy) return;
    setTagsBusy(pending);
    return () => setTagsBusy(false);
  }, [setTagsBusy, pending]);

  const markReviewed = () => {
    if (pending) return;
    const unsaved = tags ? tags.take() : null;
    // A custom tag still being typed can't be added: the tags form says why, and nothing is sent.
    if (unsaved === false) return;
    sent.current = unsaved;
    run(markReviewedForm(tradeId, requestKey, unsaved));
  };

  return (
    <div className="flex flex-col gap-2">
      <ActionMessage state={state} attempt={attempt} />
      <Button variant="secondary" icon={<CircleCheck aria-hidden="true" />} loading={pending} loadingText="Saving…" onClick={markReviewed}>
        {tags?.dirty ? SAVE_TAGS_AND_MARK_REVIEWED : MARK_REVIEWED}
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
