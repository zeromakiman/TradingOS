"use client";

import { Save } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { saveDailyContext } from "@/app/(app)/today/actions";
import { idleState } from "@/app/actions/state";
import { useModifierKeyLabel } from "@/components/shell/use-media-query";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormAlert } from "@/components/ui/form-alert";
import { KbdCombo } from "@/components/ui/kbd";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import { Textarea } from "@/components/ui/textarea";
import { NOTES_HINT, NOTES_MAX_LENGTH, NOTES_PLACEHOLDER, NOTES_TITLE } from "./copy";

/**
 * Today's plan · notes editor (docs/V2_ARCHITECTURE.md §14.1): the V1 daily context of one trading account, saved as a
 * new revision through `saveDailyContext` (React `useActionState`; Ctrl/⌘+Enter saves). The text stays the person's
 * while a save runs; once the saved revision comes back from the server it becomes the new baseline.
 */

/** Characters as the database counts them (code points). */
const lengthOf = (text: string) => [...text].length;
/** Line breaks as a textarea reports them (earlier revisions may carry CRLF from a form submission). */
const lines = (text: string) => text.replace(/\r\n?/g, "\n");

export function NotesEditor({ accountId, narrative: stored }: { accountId: string; narrative: string }) {
  const narrative = lines(stored);
  const [state, action, pending] = useActionState(saveDailyContext, idleState);
  const [text, setText] = useState(narrative);
  const [baseline, setBaseline] = useState(narrative);
  const [attempt, setAttempt] = useState(0);
  const modifier = useModifierKeyLabel();
  const field = useRef<HTMLTextAreaElement>(null);

  // A newer saved revision replaces the text only when the person has not changed it since the last one.
  if (narrative !== baseline) {
    setBaseline(narrative);
    if (text === baseline) setText(narrative);
  }

  useEffect(() => {
    if (state.status === "error" && state.fieldErrors?.narrative) field.current?.focus();
  }, [state]);

  const length = lengthOf(text);
  const tooLong = length > NOTES_MAX_LENGTH;
  const dirty = text !== narrative;
  const fieldError = state.status === "error" ? state.fieldErrors?.narrative : undefined;
  // The section header already says when the notes were saved; this line reports what is happening now.
  const status = pending ? "Saving…" : dirty ? "Unsaved changes" : state.status === "success" ? (state.message ?? null) : null;

  return (
    <form
      action={action}
      onSubmit={event => {
        // Ctrl/⌘+Enter submits even while the button is disabled: nothing to save, or too long to save.
        if (!dirty || tooLong) event.preventDefault();
        else setAttempt(value => value + 1);
      }}
      className="flex flex-col gap-3"
      aria-label={NOTES_TITLE}
      aria-busy={pending}
    >
      <input type="hidden" name="accountId" value={accountId} />
      {state.status === "error" && !fieldError && (
        <FormAlert key={attempt} tone="error">
          {state.message}
        </FormAlert>
      )}
      <Field label={NOTES_TITLE} labelHidden hint={NOTES_HINT} error={fieldError ?? (tooLong ? `Keep today's plan to ${NOTES_MAX_LENGTH.toLocaleString("en-US")} characters.` : undefined)}>
        <Textarea
          ref={field}
          name="narrative"
          rows={5}
          value={text}
          placeholder={NOTES_PLACEHOLDER}
          onChange={event => setText(lines(event.target.value))}
          onKeyDown={submitOnModifierEnter}
          className="min-h-32 max-h-[28rem]"
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="t-caption flex flex-wrap items-center gap-x-3 gap-y-1">
          <span role="status" className={dirty && !pending ? "font-medium text-warn" : undefined}>
            {status}
          </span>
          {length > NOTES_MAX_LENGTH * 0.9 && (
            <span className={tooLong ? "text-neg" : undefined}>
              {length.toLocaleString("en-US")} / {NOTES_MAX_LENGTH.toLocaleString("en-US")}
            </span>
          )}
          <span className="hidden items-center gap-1 md:inline-flex">
            <KbdCombo keys={[modifier, "Enter"]} label={`${modifier === "⌘" ? "Command" : "Control"} Enter`} /> saves
          </span>
        </p>
        <Button type="submit" variant="secondary" size="sm" icon={<Save aria-hidden="true" />} loading={pending} loadingText="Saving…" disabled={!dirty || tooLong}>
          Save notes
        </Button>
      </div>
    </form>
  );
}
