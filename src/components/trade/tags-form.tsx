"use client";

import { Plus, Tags, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import { setTags } from "@/app/actions/trades";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import { GRADE_LABELS, GRADES, LIQUIDITY_CONTEXTS, LIQUIDITY_LABELS, MSS_TIMEFRAMES } from "./copy";
import { ActionMessage, useNotify } from "./action-message";
import { addTags, MAX_TAGS, sameTags, type TagValues } from "./form-model";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Tags of a trade (docs/V2_ARCHITECTURE.md §2.5, §3.8): setup grade, liquidity context, MSS timeframe and up to 12
 * custom tags, editable in every state. Each save appends a tag set (history keeps the earlier ones); the Journal and
 * EDGE filter by them. Tags carried over from an earlier version of Trading OS are shown until the first save.
 */

export interface TagsFormProps {
  tradeId: string;
  initial: TagValues;
  /** `V1`: the shown tags come from an earlier version (read-only until saved here). */
  source: "V1" | "V2" | null;
}

const NONE = "";
const GRADE_OPTIONS = [{ value: NONE, label: "Not set" }, ...GRADES.map(grade => ({ value: grade, label: GRADE_LABELS[grade] }))];
const MSS_OPTIONS = [{ value: NONE, label: "Not set" }, ...MSS_TIMEFRAMES.map(value => ({ value, label: value }))];

export function TagsForm({ tradeId, initial, source }: TagsFormProps) {
  const notify = useNotify();
  const [saved, setSaved] = useState<TagValues>(initial);
  const [values, setValues] = useState<TagValues>(initial);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  // The values a save sent: they become the saved state once the action confirms them.
  const sent = useRef<TagValues>(initial);
  const { state, pending, run, attempt } = useTradeAction(setTags, result => {
    setSaved(sent.current);
    notify(result.message);
  });
  const dirty = !sameTags(values, saved) || input.trim() !== "";

  const commitInput = (): readonly string[] | null => {
    const result = addTags(values.tags, input);
    if (!result.ok) {
      setInputError(result.error);
      return null;
    }
    setInputError(null);
    setInput("");
    setValues(current => ({ ...current, tags: result.tags }));
    return result.tags;
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commitInput();
    } else if (event.key === "Backspace" && input === "" && values.tags.length > 0) {
      setValues(current => ({ ...current, tags: current.tags.slice(0, -1) }));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const tags = commitInput();
    if (tags === null) return;
    sent.current = { ...values, tags };
    const form = formOf({ tradeId, grade: values.grade, liquidity: values.liquidity, mss: values.mss });
    for (const tag of tags) form.append("tags", tag);
    run(form);
  };

  return (
    <form noValidate onSubmit={submit} onKeyDown={submitOnModifierEnter} aria-label="Tags" className="flex flex-col gap-4" data-form="tags">
      {source === "V1" && <p className="t-caption">These tags come from an earlier version of Trading OS. Saving here records them as a new tag set.</p>}
      <ChoiceChips
        name="grade"
        legend="Setup grade"
        options={GRADE_OPTIONS}
        value={values.grade ?? NONE}
        disabled={pending}
        onValueChange={value => setValues(current => ({ ...current, grade: value === NONE ? null : value }))}
      />
      <div className="grid gap-4 @md:grid-cols-2">
        <Field label="Liquidity context" id={`tags-liquidity-${tradeId}`}>
          <Select value={values.liquidity ?? NONE} disabled={pending} onChange={event => setValues(current => ({ ...current, liquidity: event.target.value === NONE ? null : event.target.value }))}>
            <option value={NONE}>Not set</option>
            {LIQUIDITY_CONTEXTS.map(value => (
              <option key={value} value={value}>
                {LIQUIDITY_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        <ChoiceChips
          name="mss"
          legend="MSS timeframe"
          options={MSS_OPTIONS}
          value={values.mss ?? NONE}
          disabled={pending}
          onValueChange={value => setValues(current => ({ ...current, mss: value === NONE ? null : value }))}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Field
          label="Custom tags"
          id={`tags-input-${tradeId}`}
          hint={`Up to ${MAX_TAGS} · Enter or comma adds a tag · a–z, 0–9, space, _ or -`}
          error={inputError ?? undefined}
        >
          <Input
            value={input}
            readOnly={pending}
            placeholder={values.tags.length >= MAX_TAGS ? "Tag limit reached" : "london, sweep, a-setup"}
            disabled={values.tags.length >= MAX_TAGS && input === ""}
            autoComplete="off"
            onKeyDown={onInputKey}
            onChange={event => {
              setInput(event.target.value);
              setInputError(null);
            }}
            endAdornment={
              input.trim() ? (
                <button type="button" className="inline-flex items-center gap-1 text-accent" onClick={() => commitInput()}>
                  <Plus aria-hidden="true" className="size-3.5" />
                  Add
                </button>
              ) : undefined
            }
          />
        </Field>
        {values.tags.length > 0 && (
          <ul aria-label="Selected custom tags" className="filter-chip-list">
            {values.tags.map(tag => (
              <li key={tag} className="chip">
                <span>{tag}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove tag ${tag}`}
                  disabled={pending}
                  onClick={() => setValues(current => ({ ...current, tags: current.tags.filter(value => value !== tag) }))}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ActionMessage state={state} attempt={attempt} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {!dirty && state.status !== "error" && <p className="t-caption mr-auto">Saved tags filter the Journal and EDGE.</p>}
        <Button type="submit" variant="secondary" icon={<Tags aria-hidden="true" />} loading={pending} loadingText="Saving…" disabled={!dirty}>
          Save tags
        </Button>
      </div>
    </form>
  );
}
