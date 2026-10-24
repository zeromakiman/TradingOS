import { CircleAlert, TriangleAlert } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import type { FieldHint } from "./plan-model";

/**
 * Building blocks shared by the trade forms: numbered sections, hints that flag a problem with an icon and words (never
 * colour alone), the error line of a radio group, the account chip of the header, focus helpers and the form's keyboard
 * rules (Ctrl/⌘+Enter submits; a plain Enter in a field, on a checkbox or on a radio never submits a half-finished plan).
 */

export function FormSection({ step, title, description, aside, children, id }: {
  step?: number; title: string; description?: ReactNode; aside?: ReactNode; children: ReactNode; id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section aria-labelledby={headingId} id={id} className="flex flex-col gap-4 border-border border-t px-4 py-5 first:border-t-0 md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-start gap-2.5">
          {step !== undefined && (
            <span aria-hidden="true" className="num mt-px grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken font-semibold text-text-2 text-xs ring-1 ring-border">
              {step}
            </span>
          )}
          <div className="min-w-0">
            <h2 id={headingId} className="font-semibold text-text">
              {title}
            </h2>
            {description && <p className="t-meta">{description}</p>}
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Phone layout of a SegmentedControl: the group spans the field and each option takes an equal share, so Long/Short
 * and Now/Earlier are large touch targets; from `sm` up it is the compact inline control again.
 */
export const SEGMENTED_FULL_ON_PHONE =
  "max-sm:[&_.segmented]:flex max-sm:[&_.segmented]:w-full max-sm:[&_.segmented-item]:flex-1 max-sm:[&_.segmented-label]:w-full max-sm:[&_.segmented-label]:justify-center";

/** Phone layout of ChoiceChips: equal columns instead of wrapping rows (risk presets read as one control). */
export const CHIPS_GRID_ON_PHONE =
  "max-sm:[&_.filter-chips]:grid max-sm:[&_.filter-chips]:grid-cols-[repeat(auto-fit,minmax(3.25rem,1fr))] max-sm:[&_.chip-toggle]:justify-center max-sm:[&_.chip-toggle]:px-1.5";

/** Phone layout of three ChoiceChips with long labels: two equal columns, the last option across both. */
export const CHIPS_PAIRS_ON_PHONE =
  "max-sm:[&_.filter-chips]:grid max-sm:[&_.filter-chips]:grid-cols-2 max-sm:[&_.chip-toggle]:justify-center max-sm:[&_.chip-toggle:last-child]:col-span-2";

/** A legend with the required marker of `Field` (the radios carry `required` for assistive technology). */
export function RequiredLegend({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <span className="field-required ml-1" aria-hidden="true">
        *
      </span>
    </>
  );
}

/** A read-only value laid out like a field (label, value, hint), for values a form shows but can't change. */
export function StaticField({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <p className="flex min-h-10 items-center font-medium text-text">{value}</p>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/** A field hint; a warning carries an icon and its words. */
export function HintText({ hint }: { hint: FieldHint | null | undefined }) {
  if (!hint) return null;
  if (!hint.warning) return <>{hint.text}</>;
  return (
    <span className="inline-flex items-start gap-1 text-warn">
      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>{hint.text}</span>
    </span>
  );
}

/** Error line under a radio group or chip group (linked with `aria-describedby`). */
export function GroupError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="field-error">
      <CircleAlert aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

/** `FTMO 100K · USD`: the form header repeats the account and its currency (spec §9.2). */
export function AccountChip({ name, currency, className }: { name: string; currency: string; className?: string }) {
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1 font-medium text-sm text-text", className)}>
      <span className="truncate">{name}</span>
      <span aria-hidden="true" className="text-text-3">
        ·
      </span>
      <span className="text-text-2">{currency}</span>
    </span>
  );
}

/** Input types whose own Enter behaviour stays: a button activates, a file or colour input opens its picker. */
const ENTER_ACTIVATES = new Set(["submit", "button", "reset", "image", "file", "color"]);

/**
 * Whether a plain Enter on an `<input type=…>` is cancelled. On every input except buttons and pickers (text and number
 * fields, date and time fields, checkboxes, radios and the chips built on them) the browser would submit the form
 * implicitly, saving a half-finished plan or recording a position with the default entry time.
 */
export function blocksPlainEnter(type: string): boolean {
  return !ENTER_ACTIVATES.has(type.toLowerCase());
}

/**
 * Ctrl/⌘+Enter submits the form (§13.4); a plain Enter in a field or on a checkbox or radio is ignored instead of
 * submitting (Space still ticks and selects). Buttons, links, selects and the thesis textarea keep their own Enter.
 */
export function formKeyDown(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  if (event.metaKey || event.ctrlKey) {
    submitOnModifierEnter(event);
    return;
  }
  const target = event.target;
  if (target instanceof HTMLInputElement && blocksPlainEnter(target.type)) event.preventDefault();
}

/**
 * Moves focus to a field by id: the element itself, or inside a group its checked control, else its first enabled
 * control. (One `querySelector` with a selector list would return the first match in document order, so a radio group
 * would focus its first option rather than the chosen one.)
 */
export function focusField(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  const target = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
    ? element
    : element.querySelector<HTMLElement>("input:checked:not(:disabled)") ?? element.querySelector<HTMLElement>("input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled)");
  target?.focus();
  target?.scrollIntoView({ block: "center" });
}
