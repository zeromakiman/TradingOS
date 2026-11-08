"use client";

import { Check, ChevronDown, ListFilter, Square, SquareCheck, X } from "lucide-react";
import { type RefObject, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FilterLink, formHref, useJournalNav } from "./journal-nav";
import type { DateFormView, FilterMenuView, FilterOptionView, TextFormView } from "./types";

/**
 * One filter of the Journal's filter row (desktop): a pill that names the filter and, when active, its value, with a
 * remove button; it opens a popover of options (links: URL state). Single-choice menus close on selection; State and
 * Tags stay open so several values can be toggled.
 *
 * Focus never falls back to the page (§13.5): removing a filter focuses its pill, which stays; a pill that exists only
 * while its filter is on (Origin, Session, Review, AI review) passes `onGone` to focus "More filters" instead; a tag
 * added or removed inside the Tags popover leaves focus in its "Add a tag" field.
 */

/**
 * Radix focuses the first non-link control when a popover opens (here: a date input). Option menus instead focus the
 * selected option (else the first one), so arrow-free keyboard use starts where the current value is.
 */
function focusSelectedOption(event: Event) {
  const content = event.target instanceof HTMLElement ? event.target : null;
  const option = content?.querySelector<HTMLElement>("a[aria-current=\"true\"]") ?? content?.querySelector<HTMLElement>("a[href]");
  if (!option) return;
  event.preventDefault();
  option.focus();
}

const pillBase = "inline-flex min-h-10 items-center gap-1.5 rounded-full text-[0.8125rem] font-medium whitespace-nowrap pointer-coarse:min-h-11";

function OptionList({
  options, multiple, label, onSelect,
}: { options: FilterOptionView[]; multiple: boolean; label: string; onSelect?: (option: FilterOptionView) => void }) {
  if (!options.length) return null;
  return (
    <ul aria-label={label} className="flex flex-col">
      {options.map(option => {
        const Icon = multiple ? (option.selected ? SquareCheck : Square) : Check;
        return (
          <li key={option.key}>
            <FilterLink
              href={option.href}
              aria-current={option.selected ? "true" : undefined}
              onSelect={onSelect ? () => onSelect(option) : undefined}
              className={cx(
                "flex min-h-10 items-center gap-2.5 rounded-control px-2.5 text-sm text-1 no-underline hover:bg-surface-sunken focus-visible:-outline-offset-2",
                option.selected && "font-medium",
              )}
            >
              <Icon aria-hidden="true" className={cx("size-4 flex-none", option.selected ? "text-accent" : multiple ? "text-3" : "invisible")} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </FilterLink>
          </li>
        );
      })}
    </ul>
  );
}

function HiddenFields({ form }: { form: DateFormView | TextFormView }) {
  return form.hidden.map(field => <input key={`${field.name}=${field.value}`} type="hidden" name={field.name} value={field.value} />);
}

function DateForm({ form, onDone }: { form: DateFormView; onDone: () => void }) {
  const id = useId();
  const { navigate } = useJournalNav();
  return (
    <form
      action="/journal"
      method="get"
      className="flex flex-col gap-2 border-t border-border pt-3"
      onSubmit={event => {
        event.preventDefault();
        onDone();
        navigate(formHref(new FormData(event.currentTarget).entries()));
      }}
    >
      <p className="text-xs font-semibold text-3">Custom range</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`from${id}`} className="text-xs text-2">
            From
          </label>
          <input id={`from${id}`} type="date" name="from" defaultValue={form.from} max={form.max} className="input num" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`to${id}`} className="text-xs text-2">
            To
          </label>
          <input id={`to${id}`} type="date" name="to" defaultValue={form.to} max={form.max} className="input num" />
        </div>
      </div>
      <HiddenFields form={form} />
      <Button type="submit" variant="secondary" size="sm" className="self-end">
        Apply range
      </Button>
    </form>
  );
}

/** Add a tag / pick an instrument: a typed value (validated in the field) or a quick pick from this page. */
export function TextForm({ form, inputRef, onDone, onPick }: {
  form: TextFormView;
  inputRef: RefObject<HTMLInputElement | null>;
  /** After the form is submitted. */
  onDone: () => void;
  /** After a quick pick is chosen. */
  onPick: () => void;
}) {
  const id = useId();
  const { navigate } = useJournalNav();
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <form
        action="/journal"
        method="get"
        className="flex flex-col gap-1"
        onSubmit={event => {
          event.preventDefault();
          onDone();
          navigate(formHref(new FormData(event.currentTarget).entries()));
        }}
      >
        <label htmlFor={`${form.name}${id}`} className="text-xs font-semibold text-3">
          {form.label}
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id={`${form.name}${id}`}
            name={form.name}
            required
            pattern={form.pattern}
            title={form.format}
            maxLength={form.maxLength}
            autoComplete="off"
            placeholder={form.placeholder}
            className={cx("input", form.name === "instrument" && "uppercase placeholder:normal-case")}
          />
          <HiddenFields form={form} />
          <Button type="submit" variant="secondary" size="sm" className="self-center">
            {form.submitLabel}
          </Button>
        </div>
      </form>
      {form.suggestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-3">{form.suggestionsLabel}</p>
          <ul className="flex flex-wrap gap-1.5">
            {form.suggestions.map(option => (
              <li key={option.key}>
                <FilterLink
                  href={option.href}
                  onSelect={onPick}
                  className="inline-flex min-h-8 items-center rounded-full border border-border-strong bg-surface px-2.5 text-xs font-medium text-2 no-underline hover:border-accent hover:text-accent"
                >
                  {option.label}
                </FilterLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "More filters": the less frequent single-choice filters, one section each, in one popover. */
export function MoreFiltersMenu({ menus, triggerRef, className }: { menus: FilterMenuView[]; triggerRef?: RefObject<HTMLButtonElement | null>; className?: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cx(
            pillBase,
            "border border-dashed border-border-strong bg-surface px-2.5 text-2 hover:border-text-3 hover:text-1 data-[state=open]:border-accent data-[state=open]:text-accent",
            className,
          )}
        >
          <ListFilter aria-hidden="true" className="size-3.5 flex-none" />
          More filters
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-72 flex-col gap-1 overflow-y-auto p-2"
        aria-label="More filters"
        onOpenAutoFocus={focusSelectedOption}
      >
        {menus.map(menu => (
          <section key={menu.key} aria-label={menu.label} className="flex flex-col border-b border-border pb-1 last:border-b-0">
            <p className="px-2.5 pt-1.5 pb-0.5 text-xs font-semibold text-3">{menu.label}</p>
            <OptionList options={menu.options} multiple={false} label={menu.label} onSelect={close} />
            {menu.hint && <p className="px-2.5 pb-1 text-xs text-3">{menu.hint}</p>}
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function FilterMenu({ menu, onGone, className }: {
  menu: FilterMenuView;
  /** For a pill shown only while its filter is on: where focus goes when the filter is turned off. */
  onGone?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Replaces Radix's return of focus to the trigger once the popover has closed. */
  const focusOnClose = useRef<(() => void) | null>(null);
  const active = menu.activeLabel !== null;
  const close = () => setOpen(false);
  const removed = onGone ?? (() => triggerRef.current?.focus());
  const keepInField = () => inputRef.current?.focus();
  // Single choice: close the popover; an option that turns the filter off sends focus where `removed` says.
  const selectSingle = (option: FilterOptionView) => {
    if (onGone && option.href === menu.removeHref) focusOnClose.current = onGone;
    close();
  };
  // Tags: the toggled tag leaves the list it was in, so focus stays in the popover's field. State options stay put.
  const selectMultiple = menu.form?.kind === "text" ? keepInField : undefined;
  const trigger = (
    <PopoverTrigger asChild>
      <button
        ref={triggerRef}
        type="button"
        className={cx(
          pillBase,
          active
            ? "pr-1 pl-2.5 text-accent hover:underline hover:underline-offset-2"
            : "border border-border-strong bg-surface px-2.5 text-2 hover:border-text-3 hover:text-1 data-[state=open]:border-accent data-[state=open]:text-accent",
        )}
      >
        <span>
          {menu.label}
          {active && <span className="font-semibold">: {menu.activeLabel}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 flex-none" />
      </button>
    </PopoverTrigger>
  );
  return (
    <div
      className={cx(
        "items-center",
        active ? "inline-flex rounded-full border border-accent/40 bg-accent-soft" : "inline-flex",
        className,
      )}
      data-active={active || undefined}
    >
      <Popover open={open} onOpenChange={setOpen}>
        {trigger}
        <PopoverContent
          align="start"
          className="flex w-72 flex-col gap-2 p-2"
          aria-label={`${menu.label} filter`}
          onOpenAutoFocus={menu.form?.kind === "text" ? undefined : focusSelectedOption}
          onCloseAutoFocus={event => {
            const next = focusOnClose.current;
            focusOnClose.current = null;
            if (!next) return;
            event.preventDefault();
            next();
          }}
        >
          <OptionList
            options={menu.options}
            multiple={menu.multiple}
            label={menu.label}
            onSelect={menu.multiple ? selectMultiple : selectSingle}
          />
          {menu.form?.kind === "date" && (
            <div className="px-1 pb-1">
              <DateForm form={menu.form} onDone={close} />
            </div>
          )}
          {menu.form?.kind === "text" && (
            <div className={cx("px-1 pb-1", menu.options.length === 0 && "pt-1")}>
              <TextForm form={menu.form} inputRef={inputRef} onDone={close} onPick={menu.multiple ? keepInField : close} />
            </div>
          )}
          {menu.hint && <p className="border-t border-border px-2.5 pt-2 pb-1 text-xs text-3">{menu.hint}</p>}
        </PopoverContent>
      </Popover>
      {active && menu.removeHref && (
        <FilterLink
          href={menu.removeHref}
          aria-label={`Remove filter: ${menu.label}: ${menu.activeLabel}`}
          onSelect={removed}
          className="chip-remove mr-1"
        >
          <X aria-hidden="true" />
        </FilterLink>
      )}
    </div>
  );
}
