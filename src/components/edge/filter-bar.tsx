"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { PendingLink, useEdgeTransition } from "./pending";
import { EDGE_PATH, type EdgeUrlState, edgeParams, type RangePreset, withParams } from "./params";

export type FilterOption = { value: string; label: string };

/** Calendar mode and currency as the URL holds them now (the calendar updates them in place), else from the render. */
function currentCalendarParams(state: EdgeUrlState): Record<string, string | undefined> {
  const fallback = edgeParams({ range: "all", calendar: state.calendar, currency: state.currency });
  const current = typeof window === "undefined" ? fallback : new URLSearchParams(window.location.search);
  return { view: current.get("view") ?? undefined, currency: current.get("currency") ?? undefined };
}

export type FilterSelect = {
  name: "model" | "session" | "origin" | "instrument";
  /** Accessible name, for example "Model". */
  label: string;
  /** Options including the "All …" option with the empty value. */
  options: FilterOption[];
  value: string;
};

/** The read-only account filter of All Accounts (src/components/edge/query.ts `accountFilterChip`). */
export type EdgeAccountFilter = {
  /** Account id, carried along by every filter change; never shown. */
  id: string;
  /** "Account: Personal 12K · archived". */
  label: string;
  /** The page without the account filter. */
  removeHref: string;
};

export type EdgeFilterBarProps = {
  /** Current URL state (filters and calendar mode). */
  state: EdgeUrlState;
  rangeOptions: { value: RangePreset; label: string }[];
  selects: FilterSelect[];
  /** Shown as a removable chip in words; kept by every other filter change. */
  accountFilter?: EdgeAccountFilter | null;
};

/**
 * The EDGE filter row (§14.6): date range presets or a custom range of exit days, model, session, origin and
 * instrument, plus the read-only account filter when a link narrowed All Accounts to one account. Every change
 * navigates (URL state) inside the page transition, so the previous results stay visible, dimmed, until the new ones
 * arrive. Below 768px the dimension filters fold behind a "Filters" button.
 */
export function EdgeFilterBar({ state, rangeOptions, selects, accountFilter = null }: EdgeFilterBarProps) {
  const router = useRouter();
  const { start } = useEdgeTransition();
  const [range, setRange] = useState<RangePreset>(state.range);
  const [from, setFrom] = useState(state.closedFrom ?? "");
  const [to, setTo] = useState(state.closedTo ?? "");
  const [open, setOpen] = useState(false);
  const groupId = useId();
  const rangeRef = useRef<HTMLSelectElement>(null);
  const dimensionCount = selects.filter(select => select.value !== "").length;
  const active = dimensionCount + (state.range === "all" ? 0 : 1) + (accountFilter ? 1 : 0);

  // A filter change shows the month of the new results (the calendar month is not carried over) and keeps the
  // calendar mode and currency, which the calendar may have changed in the URL since the page rendered, and the
  // account filter.
  const navigate = (next: EdgeUrlState) => {
    const base = edgeParams({ ...next, month: undefined, calendar: "NET_R", currency: undefined }).toString();
    const href = withParams(base, { ...currentCalendarParams(next), accountFilter: accountFilter?.id });
    start(() => router.push(href, { scroll: false }));
  };

  const changeRange = (value: RangePreset) => {
    setRange(value);
    if (value !== "custom") navigate({ ...state, range: value, closedFrom: undefined, closedTo: undefined });
  };

  const applyCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (range !== "custom") return;
    navigate({ ...state, range: "custom", closedFrom: from || undefined, closedTo: to || undefined });
  };

  return (
    <form aria-label="Filter closed trades" className="flex flex-wrap items-start gap-2" onSubmit={applyCustom}>
      {accountFilter && (
        <div className="filter-chips w-full">
          <ul className="filter-chip-list" aria-label="Account filter">
            <li className="chip">
              <span>{accountFilter.label}</span>
              {/* Focus stays in the filter row: the date range takes it while the chip goes away. */}
              <PendingLink href={accountFilter.removeHref} className="chip-remove" aria-label={`Remove filter: ${accountFilter.label}`} onClick={() => rangeRef.current?.focus()}>
                <X aria-hidden="true" />
              </PendingLink>
            </li>
          </ul>
        </div>
      )}
      <Field label="Date range" labelHidden className="min-w-0 flex-1 sm:w-44 sm:flex-none">
        <Select ref={rangeRef} name="range" value={range} onChange={event => changeRange(event.target.value as RangePreset)} className={cx(range !== "all" && "border-accent")}>
          {rangeOptions.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {range === "custom" && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Field label="First exit day" labelHidden className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <Input type="date" name="closedFrom" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} />
          </Field>
          <span className="t-meta" aria-hidden="true">
            to
          </span>
          <Field label="Last exit day" labelHidden className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <Input type="date" name="closedTo" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!from && !to}>
            Apply
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="secondary"
        className={cx("md:hidden", (open || dimensionCount > 0) && "border-accent text-accent")}
        icon={<SlidersHorizontal aria-hidden="true" />}
        aria-expanded={open}
        aria-controls={groupId}
        onClick={() => setOpen(value => !value)}
      >
        {dimensionCount ? `Filters · ${dimensionCount}` : "Filters"}
      </Button>
      <div id={groupId} className={cx(open ? "grid" : "hidden", "w-full grid-cols-2 gap-2 md:flex md:w-auto md:flex-wrap")}>
        {selects.map(select => (
          <Field key={select.name} label={select.label} labelHidden className="min-w-0 md:w-40">
            <Select
              name={select.name}
              value={select.value}
              onChange={event => navigate({ ...state, [select.name]: event.target.value || undefined })}
              className={cx(select.value !== "" && "border-accent")}
            >
              {select.options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      {active > 0 && (
        <PendingLink href={EDGE_PATH} className={buttonClasses({ variant: "ghost", className: "text-2" })}>
          Reset filters
        </PendingLink>
      )}
    </form>
  );
}
