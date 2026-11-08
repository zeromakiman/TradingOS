"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import type { ActionState } from "@/app/actions/state";
import { cx } from "@/components/ui/cx";
import { ConfirmDialog } from "@/components/ui/dialog";
import type { ReviewFact } from "./close-model";
import { returnFocusTo } from "./reveal";

/**
 * Confirmation of a record that can't be changed later, the close of a trade or an entry that differs from the plan
 * (spec §57; docs/V2_ARCHITECTURE.md §3.4–3.5, §8.5): what will be recorded, and for a close the result, before the
 * trader confirms. Opened by the form's submit (button, Enter or Ctrl/⌘+Enter), so no key press records anything on its
 * own; focus starts on the button that goes back to the form. A refusal stays in the dialog with the action's words;
 * once the dialog closes, the form receives the last result (`onClosed`) to show its field errors and to place focus.
 */

export interface ReviewGroup {
  title: string;
  facts: readonly ReviewFact[];
}

const TONE: Readonly<Record<NonNullable<ReviewFact["tone"]>, string>> = { positive: "value-pos", negative: "value-neg", muted: "text-text-3" };

function FactList({ title, facts }: ReviewGroup) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-[0.8125rem] font-semibold text-text">
        {title}
      </h3>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        {facts.map(fact => (
          <div key={fact.label} className="contents" data-fact={fact.label}>
            <dt className="t-meta">{fact.label}</dt>
            <dd className="flex min-w-0 flex-col gap-0.5">
              <span className={cx("font-medium", fact.tone === "muted" ? TONE.muted : cx("num", fact.tone ? TONE[fact.tone] : "text-text"))}>{fact.value}</span>
              {fact.hint && <span className="t-caption break-words">{fact.hint}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The control a dialog gives focus back to: the field Enter was pressed in, or the button that submitted the form. */
function submitOrigin(event: FormEvent<HTMLFormElement>): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  const submitter = (event.nativeEvent as SubmitEvent).submitter;
  return submitter instanceof HTMLElement ? submitter : null;
}

/**
 * A form's confirmation: what waits to be confirmed (`pending`; the dialog is open while it is set), `open` from the
 * form's submit, and `closed` for the dialog's `onClosed`: after a refusal the form shows it (`show`, with its field
 * errors), and focus goes back to what submitted the form, as when the trader goes back without sending anything.
 */
export function useRecordConfirmation<P, T>(show: (result: ActionState<T>) => void) {
  const [pending, setPending] = useState<P | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  return {
    pending,
    open: (event: FormEvent<HTMLFormElement>, value: P) => {
      opener.current = submitOrigin(event);
      setPending(value);
    },
    closed: (result: ActionState<T> | null) => {
      setPending(null);
      if (result?.status === "success") return;
      if (result?.status === "error") show(result);
      returnFocusTo(opener.current);
    },
  };
}

export interface RecordConfirmDialogProps<T> {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  cancelLabel: string;
  groups: readonly ReviewGroup[];
  /** Sends the record. Success closes the dialog; an error state keeps it open with its message. */
  onConfirm: () => Promise<ActionState<T>>;
  /** The dialog closed: after the success, after a refusal it showed, or before anything was sent (null). */
  onClosed: (result: ActionState<T> | null) => void;
}

export function RecordConfirmDialog<T>({ open, title, description, confirmLabel, pendingLabel, cancelLabel, groups, onConfirm, onClosed }: RecordConfirmDialogProps<T>) {
  const last = useRef<ActionState<T> | null>(null);
  const confirm = async () => {
    const result = await onConfirm();
    last.current = result;
    return result;
  };
  const change = (next: boolean) => {
    if (next) return;
    const result = last.current;
    last.current = null;
    onClosed(result);
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      pendingLabel={pendingLabel}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4 [&>section+section]:border-t [&>section+section]:border-border [&>section+section]:pt-4">
        {groups.map(group => (
          <FactList key={group.title} title={group.title} facts={group.facts} />
        ))}
      </div>
    </ConfirmDialog>
  );
}
