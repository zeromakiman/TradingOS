"use client";

import { Plus, Tags, X } from "lucide-react";
import {
  createContext, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from "react";
import { setTags } from "@/app/actions/trades";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import { GRADE_LABELS, GRADES, LIQUIDITY_CONTEXTS, LIQUIDITY_LABELS, MSS_TIMEFRAMES } from "./copy";
import { ActionMessage, useNotify } from "./action-message";
import { useLeaveGuard } from "./forms/leave-guard";
import { addTags, MAX_TAGS, sameTags, type TagValues } from "./form-model";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Tags of a trade (docs/V2_ARCHITECTURE.md §2.5, §3.8): setup grade, liquidity context, MSS timeframe and up to 12
 * custom tags, editable in every state. Each save appends a tag set (history keeps the earlier ones); the Journal and
 * EDGE filter by them. Tags carried over from an earlier version of Trading OS are shown until the first save.
 * Unsaved changes are never lost silently: leaving the page asks first, and inside a `TagsDraftScope` (the Review
 * section) Mark reviewed saves them before it marks the trade reviewed (`useUnsavedTags`).
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

/** The `setTags` fields of a tag set (grade, liquidity and MSS only when set; one `tags` value per custom tag). */
export function withTagFields(form: FormData, values: TagValues): FormData {
  for (const key of ["grade", "liquidity", "mss"] as const) {
    const value = values[key];
    if (value) form.set(key, value);
  }
  for (const tag of values.tags) form.append("tags", tag);
  return form;
}

// ---------------------------------------------------------------------------------------------------------------------
// Unsaved tags shared with the other controls of the section
// ---------------------------------------------------------------------------------------------------------------------

interface TagsDraftHandle {
  take(): TagValues | null | false;
  confirm(values: TagValues): void;
}

interface TagsDraftScopeValue {
  dirty: boolean;
  busy: boolean;
  handle: RefObject<TagsDraftHandle | null>;
  setDirty(dirty: boolean): void;
  setBusy(busy: boolean): void;
}

const TagsDraftContext = createContext<TagsDraftScopeValue | null>(null);

/** Lets the controls inside it (Mark reviewed) see and save the tags form's unsaved changes. */
export function TagsDraftScope({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const handle = useRef<TagsDraftHandle | null>(null);
  const value = useMemo(() => ({ dirty, busy, handle, setDirty, setBusy }), [dirty, busy]);
  return <TagsDraftContext.Provider value={value}>{children}</TagsDraftContext.Provider>;
}

export interface UnsavedTags {
  /** The tags form holds changes that aren't saved. */
  dirty: boolean;
  /**
   * The unsaved tag set to save now (a custom tag still being typed is added first); null when nothing is unsaved;
   * false when that typed tag can't be added (the form says why and focuses it).
   */
  take(): TagValues | null | false;
  /** Another action saved `values`: the form shows them as saved. */
  confirm(values: TagValues): void;
  /** Another action is saving the form's changes: the form waits until it is done. */
  setBusy(busy: boolean): void;
}

/** The unsaved tags of the `TagsDraftScope` around this component, or null outside one. */
export function useUnsavedTags(): UnsavedTags | null {
  const scope = useContext(TagsDraftContext);
  return useMemo(
    () => scope && {
      dirty: scope.dirty,
      take: () => scope.handle.current?.take() ?? null,
      confirm: (values: TagValues) => scope.handle.current?.confirm(values),
      setBusy: scope.setBusy,
    },
    [scope],
  );
}

export function TagsForm({ tradeId, initial, source }: TagsFormProps) {
  const notify = useNotify();
  const scope = useContext(TagsDraftContext);
  const [saved, setSaved] = useState<TagValues>(initial);
  const [values, setValues] = useState<TagValues>(initial);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  // The stored tags as the page last showed them. When the page brings other ones (after a save from here, including one
  // whose review then failed, or a save made elsewhere), they are what is saved, and a form without unsaved changes
  // shows them.
  const [stored, setStored] = useState<TagValues>(initial);
  if (!sameTags(initial, stored)) {
    setStored(initial);
    setSaved(initial);
    if (sameTags(values, saved) && input.trim() === "") setValues(initial);
  }
  // The values a save sent: they become the saved state once the action confirms them.
  const sent = useRef<TagValues>(initial);
  const { state, pending, run, attempt } = useTradeAction(setTags, result => {
    setSaved(sent.current);
    notify(result.message);
  });
  const dirty = !sameTags(values, saved) || input.trim() !== "";
  // While Mark reviewed saves these changes, nothing more can be changed (it would not be part of that save).
  const locked = pending || (scope?.busy ?? false);
  const inputId = `tags-input-${tradeId}`;
  const guard = useLeaveGuard(dirty && !locked);

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

  useImperativeHandle(scope?.handle, () => ({
    take: () => {
      const tags = commitInput();
      if (tags === null) {
        document.getElementById(inputId)?.focus();
        return false;
      }
      const next: TagValues = { ...values, tags };
      return sameTags(next, saved) ? null : next;
    },
    confirm: confirmed => setSaved(confirmed),
  }));

  const setScopeDirty = scope?.setDirty;
  useEffect(() => {
    setScopeDirty?.(dirty);
  }, [setScopeDirty, dirty]);
  useEffect(() => () => setScopeDirty?.(false), [setScopeDirty]);

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
    if (locked) return;
    const tags = commitInput();
    if (tags === null) return;
    sent.current = { ...values, tags };
    run(withTagFields(formOf({ tradeId }), sent.current));
  };

  return (
    <>
      <form noValidate onSubmit={submit} onKeyDown={submitOnModifierEnter} aria-label="Tags" className="flex flex-col gap-4" data-form="tags">
        {source === "V1" && <p className="t-caption">These tags come from an earlier version of Trading OS. Saving here records them as a new tag set.</p>}
        <ChoiceChips
          name="grade"
          legend="Setup grade"
          options={GRADE_OPTIONS}
          value={values.grade ?? NONE}
          disabled={locked}
          onValueChange={value => setValues(current => ({ ...current, grade: value === NONE ? null : value }))}
        />
        <div className="grid gap-4 @md:grid-cols-2">
          <Field label="Liquidity context" id={`tags-liquidity-${tradeId}`}>
            <Select value={values.liquidity ?? NONE} disabled={locked} onChange={event => setValues(current => ({ ...current, liquidity: event.target.value === NONE ? null : event.target.value }))}>
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
            disabled={locked}
            onValueChange={value => setValues(current => ({ ...current, mss: value === NONE ? null : value }))}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Field
            label="Custom tags"
            id={inputId}
            hint={`Up to ${MAX_TAGS} · Enter or comma adds a tag · a–z, 0–9, space, _ or -`}
            error={inputError ?? undefined}
          >
            <Input
              value={input}
              readOnly={locked}
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
                    disabled={locked}
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
          <Button type="submit" variant="secondary" icon={<Tags aria-hidden="true" />} loading={pending} loadingText="Saving…" disabled={!dirty || locked}>
            Save tags
          </Button>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}
