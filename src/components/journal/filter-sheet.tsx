"use client";

import { SlidersHorizontal } from "lucide-react";
import { type RefObject, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice";
import { cx } from "@/components/ui/cx";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/dialog";
import { formHref, useJournalNav } from "./journal-nav";
import { INSTRUMENT_FORMAT, OPTIONAL_INSTRUMENT_PATTERN, TAG_LIST_FORMAT, TAG_LIST_PATTERN } from "./patterns";
import type { SheetChoiceGroup, SheetView } from "./types";

/**
 * Mobile filters (docs/V2_ARCHITECTURE.md §14.5, §13.3): a bottom sheet with every filter as touch-sized chips and one
 * "Show trades" action, so several filters change in one step. It is a GET form: the URL stays the only filter state.
 */

function CheckboxChips({ group }: { group: SheetChoiceGroup }) {
  return (
    <fieldset className="choice-group">
      <legend className="choice-legend">{group.legend}</legend>
      <div className="filter-chips">
        {group.options.map(option => (
          <label key={option.value} className="chip-toggle">
            <input className="sr-only" type="checkbox" name={group.name} value={option.value} defaultChecked={option.checked} />
            {option.label}
          </label>
        ))}
      </div>
      {group.hint && <p className="text-xs text-3">{group.hint}</p>}
    </fieldset>
  );
}

function DateFields({ sheet }: { sheet: SheetView }) {
  const id = useId();
  const [from, setFrom] = useState(sheet.date.from);
  const [to, setTo] = useState(sheet.date.to);
  const current = sheet.date.presets.find(preset => preset.from === from && preset.to === to)?.key ?? null;
  return (
    <fieldset className="choice-group">
      <legend className="choice-legend">Date</legend>
      <div className="filter-chips">
        <button type="button" className="chip-toggle" aria-pressed={!from && !to} onClick={() => { setFrom(""); setTo(""); }}>
          Any date
        </button>
        {sheet.date.presets.map(preset => (
          <button key={preset.key} type="button" className="chip-toggle" aria-pressed={current === preset.key} onClick={() => { setFrom(preset.from); setTo(preset.to); }}>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`sheet-from${id}`} className="text-xs text-2">
            From
          </label>
          <input id={`sheet-from${id}`} type="date" name="from" value={from} max={sheet.date.max} onChange={event => setFrom(event.target.value)} className="input num" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`sheet-to${id}`} className="text-xs text-2">
            To
          </label>
          <input id={`sheet-to${id}`} type="date" name="to" value={to} max={sheet.date.max} onChange={event => setTo(event.target.value)} className="input num" />
        </div>
      </div>
      <p className="text-xs text-3">Trade date: entry, else plan lock, else when recorded (UTC−5 days).</p>
    </fieldset>
  );
}

/** The sheet's GET form: every filter at once, applied with "Show trades". */
export function SheetForm({ sheet, clearHref, onDone }: { sheet: SheetView; clearHref: string | null; onDone: () => void }) {
  const id = useId();
  const { navigate } = useJournalNav();
  return (
    <form
      action="/journal"
      method="get"
      className="flex flex-col gap-5"
      onSubmit={event => {
        event.preventDefault();
        onDone();
        navigate(formHref(new FormData(event.currentTarget).entries()));
      }}
    >
      <DateFields sheet={sheet} />
      {sheet.groups.map(group =>
        group.type === "checkbox" ? (
          <CheckboxChips key={group.name} group={group} />
        ) : (
          <div key={group.name} className="flex flex-col gap-1.5">
            <ChoiceChips
              name={group.name}
              legend={group.legend}
              options={group.options.map(option => ({ value: option.value, label: option.label }))}
              defaultValue={group.options.find(option => option.checked)?.value ?? ""}
            />
            {group.hint && <p className="text-xs text-3">{group.hint}</p>}
          </div>
        ),
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`sheet-tags${id}`} className="field-label">
            Tags
          </label>
          <input
            id={`sheet-tags${id}`}
            name="tag"
            defaultValue={sheet.tags}
            pattern={TAG_LIST_PATTERN}
            title={TAG_LIST_FORMAT}
            maxLength={200}
            autoComplete="off"
            placeholder="e.g. news, london"
            className="input"
            aria-describedby={`sheet-tags-hint${id}`}
          />
          <p id={`sheet-tags-hint${id}`} className="text-xs text-3">
            Separate tags with commas; trades must carry every tag.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`sheet-instrument${id}`} className="field-label">
            Instrument
          </label>
          <input
            id={`sheet-instrument${id}`}
            name="instrument"
            defaultValue={sheet.instrument}
            pattern={OPTIONAL_INSTRUMENT_PATTERN}
            title={INSTRUMENT_FORMAT}
            autoComplete="off"
            placeholder="e.g. EURUSD"
            maxLength={20}
            className="input uppercase placeholder:normal-case"
          />
        </div>
      </div>
      {sheet.hidden.map(field => (
        <input key={`${field.name}=${field.value}`} type="hidden" name={field.name} value={field.value} />
      ))}
      {/* Pinned to the sheet's bottom edge, over its padding, so nothing scrolls visibly underneath. */}
      <div className="sticky -bottom-[calc(1rem+env(safe-area-inset-bottom))] -mx-4 -mb-[calc(1rem+env(safe-area-inset-bottom))] flex gap-2 border-t border-border bg-surface-raised px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {clearHref && (
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={() => {
              onDone();
              navigate(clearHref);
            }}
          >
            Clear all
          </Button>
        )}
        <Button type="submit" className="flex-1">
          Show trades
        </Button>
      </div>
    </form>
  );
}

export function FilterSheet({ sheet, clearHref, triggerRef, className }: {
  sheet: SheetView;
  clearHref: string | null;
  /** The "Filters" button: it stays mounted, so it takes focus when the last active-filter chip is removed. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button ref={triggerRef} variant="secondary" icon={<SlidersHorizontal aria-hidden="true" />} className={cx("flex-none", className)}>
          Filters
          {sheet.activeCount > 0 && (
            <span className="ml-0.5 inline-grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs leading-5 text-on-accent">
              <span className="sr-only">, </span>
              {sheet.activeCount}
              <span className="sr-only"> active</span>
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" title="Filter trades" description="Choose filters, then show the matching trades.">
        <SheetForm key={sheet.signature} sheet={sheet} clearHref={clearHref} onDone={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
