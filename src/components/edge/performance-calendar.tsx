"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { type MouseEvent, useId, useMemo, useRef, useState, useTransition } from "react";
import { monthLabel, monthWeeks, WEEKDAYS } from "@/components/charts/calendar";
import { ChartFrame } from "@/components/charts/chart-frame";
import { type Dec, intensityLevel, toDecimal, ZERO } from "@/components/charts/scale";
import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Refetching } from "@/components/ui/skeleton";
import { DataTable } from "@/components/ui/table";
import type { CalendarMode } from "@/domain/performance";
import { DaySheet } from "./day-sheet";
import type { CalendarDayModel, CalendarModel } from "./model";
import { CALENDAR_VIEW_PARAM, withParams } from "./params";
import { PendingLink } from "./pending";

/**
 * Performance calendar (docs/V2_ARCHITECTURE.md §13.6, §14.6): one month of closed trades by strategy day (UTC−5) of
 * the exit. Modes Net R · Net P&L (one currency at a time) · Gross realized loss · Trade count colour the cells; every
 * day with trades still prints its result, P&L and count ("+2.40R · +$480.00 · 2 trades", and how many trades have no
 * recorded risk, so a day's R never reads as covering them), so nothing depends on colour. Days without trades stay
 * clear. Clicking a day opens a sheet with that day's trades; closing it returns focus to the day. Month navigation
 * is URL state (the calendar dims until the new month arrives); the mode switch is instant and mirrored into the URL.
 */

const MODES: { mode: CalendarMode; label: string }[] = [
  { mode: "NET_R", label: "Net R" },
  { mode: "NET_PNL", label: "Net P&L" },
  { mode: "GROSS_LOSS", label: "Gross realized loss" },
  { mode: "COUNT", label: "Trade count" },
];

const LEGEND: Record<CalendarMode, [string, string]> = {
  NET_R: ["Loss", "Profit"],
  NET_PNL: ["Loss", "Profit"],
  GROSS_LOSS: ["Smaller loss", "Larger loss"],
  COUNT: ["Fewer trades", "More trades"],
};

/** Month arrows: compact on desktop, a full 44px square on touch screens (§13.5). */
const TOUCH_ICON = "pointer-coarse:min-h-11 pointer-coarse:w-11";

/** Phones list this many days with trades (latest first) until "Show all days". */
export const PHONE_DAY_LIMIT = 5;

type Tone = "pos" | "neg" | "seq";

type DayView = {
  day: CalendarDayModel;
  value: Dec | null;
  tone: Tone | undefined;
  level: number;
  /** The mode's value in words, first and bold. */
  primary: string;
  /** The day has no value in this mode (no trades in the currency, no loss, no recorded risk). */
  muted: boolean;
  /** The other figures of the day. */
  secondary: string[];
  /** Narrow cells (phones): the sign of the result, or the count; the list below the grid gives every figure. */
  compact: string;
  /** Accessible name and agenda text: every figure. */
  spoken: string;
};

function isMoneyMode(mode: CalendarMode): boolean {
  return mode === "NET_PNL" || mode === "GROSS_LOSS";
}

function moneyOf(day: CalendarDayModel, currency: string | null) {
  return currency === null ? undefined : day.money.find(entry => entry.currency === currency);
}

function signCue(value: Dec | null): string {
  if (value === null) return "·";
  return value.isZero() ? "0" : value.isNegative() ? "−" : "+";
}

export function dayView(day: CalendarDayModel, mode: CalendarMode, currency: string | null): Omit<DayView, "level"> {
  const r = day.rLabel ?? "No recorded risk";
  const nets = day.money.map(entry => entry.netLabel).join(" · ");
  const money = moneyOf(day, currency);
  const others = day.money.filter(entry => entry.currency !== currency).map(entry => entry.netLabel);
  // The count names the trades without a recorded risk: the day's R leaves them out, its money does not.
  const count = day.withoutRisk ? `${day.countLabel} · ${day.withoutRisk}` : day.countLabel;
  const spoken = [day.rDetail, nets, day.countLabel].filter(Boolean).join(", ");
  // At most three lines per cell: the mode's value, then the other figures, then the count.
  switch (mode) {
    case "NET_R": {
      const value = toDecimal(day.netR);
      return {
        day, value, tone: value === null || value.isZero() ? undefined : value.isNegative() ? "neg" : "pos",
        primary: r, muted: day.netR === null, secondary: [nets, count].filter(Boolean), compact: signCue(value), spoken,
      };
    }
    case "NET_PNL": {
      const value = toDecimal(money?.net);
      return {
        day, value, tone: value === null || value.isZero() ? undefined : value.isNegative() ? "neg" : "pos",
        primary: money?.netLabel ?? (currency ? `No ${currency} trades` : "—"), muted: money === undefined,
        secondary: [[...others, r].join(" · "), count], compact: money ? signCue(value) : "·", spoken,
      };
    }
    case "GROSS_LOSS": {
      const value = toDecimal(money?.loss);
      const hasLoss = value?.gt(0) === true;
      const primary = hasLoss && money ? `${money.lossLabel} lost` : money ? "No loss" : currency ? `No ${currency} trades` : "No loss";
      return {
        day, value, tone: hasLoss ? "neg" : undefined, primary, muted: !hasLoss,
        secondary: [nets, `${count} · ${r}`].filter(Boolean), compact: hasLoss ? "−" : "0", spoken: `${primary}, ${spoken}`,
      };
    }
    case "COUNT": {
      const value = toDecimal(String(day.closed));
      return {
        day, value, tone: "seq", primary: day.countLabel, muted: false,
        secondary: [day.withoutRisk ? `${r} · ${day.withoutRisk}` : r, nets].filter(Boolean), compact: String(day.closed), spoken,
      };
    }
  }
}

/** The visible buttons that open a day (calendar cell, phone list row, table row), for returning focus to it. */
function dayButton(day: string | null): HTMLElement | null {
  if (day === null || typeof document === "undefined") return null;
  const candidates = [...document.querySelectorAll<HTMLElement>(`[data-calendar-day="${day}"]`)];
  return candidates.find(element => element.getClientRects().length > 0) ?? null;
}

export type PerformanceCalendarProps = {
  model: CalendarModel;
  initialMode: CalendarMode;
  initialCurrency: string | null;
  /** Day whose sheet is open on arrival (`?day=`), when it has closed trades. */
  initialDay: string | null;
};

export function PerformanceCalendar({ model, initialMode, initialCurrency, initialDay }: PerformanceCalendarProps) {
  const [mode, setMode] = useState<CalendarMode>(initialMode);
  const [currency, setCurrency] = useState<string | null>(
    initialCurrency && model.currencies.includes(initialCurrency) ? initialCurrency : model.defaultCurrency,
  );
  const arrival = initialDay && model.days.some(day => day.day === initialDay) ? initialDay : null;
  const [openDay, setOpenDayState] = useState<string | null>(arrival);
  // The sheet keeps its last day while it closes, so Radix finishes the close (focus included) on real content.
  const [sheetDay, setSheetDay] = useState<string | null>(arrival);
  const [allDays, setAllDays] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const opener = useRef<HTMLElement | null>(null);
  const listId = useId();
  const moneyMode = isMoneyMode(mode);

  const views = useMemo(() => {
    const partial = model.days.map(day => dayView(day, mode, currency));
    const maxAbs = partial.reduce<Dec>((max, view) => (view.value?.abs().gt(max) ? view.value.abs() : max), ZERO);
    return new Map<string, DayView>(partial.map(view => [view.day.day, { ...view, level: view.tone && view.value ? intensityLevel(view.value, maxAbs) : 0 }]));
  }, [model.days, mode, currency]);

  const navParams = (next: { mode?: CalendarMode; currency?: string | null; month?: string; day?: string | null }) => ({
    month: next.month ?? model.month,
    view: (next.mode ?? mode) === "NET_R" ? undefined : CALENDAR_VIEW_PARAM[next.mode ?? mode],
    // The currency matters only to the money modes, and only when the month has several.
    currency: isMoneyMode(next.mode ?? mode) && model.currencies.length > 1 ? ((next.currency === undefined ? currency : next.currency) ?? undefined) : undefined,
    // Month links leave the open day behind.
    day: next.month !== undefined ? undefined : ((next.day === undefined ? openDay : next.day) ?? undefined),
  });

  // Mode, currency and the open day are instant (all values are on the page); the URL keeps them for links and reloads.
  const remember = (next: { mode?: CalendarMode; currency?: string | null; day?: string | null }) => {
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", withParams(model.baseQuery, navParams(next)));
  };
  const setOpenDay = (day: string | null) => {
    setOpenDayState(day);
    if (day !== null) setSheetDay(day);
    remember({ day });
  };
  /** Opens a day's sheet from the element the user activated, which gets the focus back when the sheet closes. */
  const openFrom = (day: string) => (event: MouseEvent<HTMLElement>) => {
    opener.current = event.currentTarget;
    setOpenDay(day);
  };
  const returnFocus = (event: Event) => {
    event.preventDefault();
    // Opened from a link with `?day=` there is no opener: the day's own button takes the focus.
    const target = opener.current?.isConnected ? opener.current : dayButton(sheetDay);
    opener.current = null;
    target?.focus();
  };
  const chooseMode = (next: CalendarMode) => {
    setMode(next);
    remember({ mode: next });
  };
  const chooseCurrency = (next: string) => {
    setCurrency(next);
    remember({ currency: next });
  };

  const weeks = monthWeeks(model.month);
  const thisMonth = model.today.slice(0, 7);
  const outside = (date: string) => (model.rangeFrom !== null && date < model.rangeFrom) || (model.rangeTo !== null && date > model.rangeTo);
  const ordered = model.days.map(day => views.get(day.day)).filter((view): view is DayView => view !== undefined);
  // Phones: the latest days first (the ones a trader usually looks for), the rest one tap away.
  const latestFirst = [...ordered].reverse();
  const listed = allDays ? latestFirst : latestFirst.slice(0, PHONE_DAY_LIMIT);
  const shown = model.days.find(day => day.day === sheetDay) ?? null;
  const tradingDays = model.days.length;
  const summary = tradingDays
    ? `${monthLabel(model.month)}: ${model.closed} closed ${model.closed === 1 ? "trade" : "trades"} on ${tradingDays} ${tradingDays === 1 ? "day" : "days"}. ${ordered.map(view => `${view.day.label} ${view.spoken}`).join("; ")}.`
    : `${monthLabel(model.month)}: no closed trades.`;
  const monthLink = (month: string) => withParams(model.baseQuery, navParams({ month }));

  const monthNav = (
    <nav className="calendar-nav" aria-label="Month">
      <PendingLink
        href={monthLink(model.previousMonth)}
        start={startNavigation}
        className={buttonClasses({ variant: "ghost", size: "sm", iconOnly: true, className: TOUCH_ICON })}
        aria-label={`Previous month, ${monthLabel(model.previousMonth)}`}
      >
        <ChevronLeft aria-hidden="true" />
      </PendingLink>
      <span className="calendar-month" aria-live="polite">
        {monthLabel(model.month)}
      </span>
      <PendingLink
        href={monthLink(model.nextMonth)}
        start={startNavigation}
        className={buttonClasses({ variant: "ghost", size: "sm", iconOnly: true, className: TOUCH_ICON })}
        aria-label={`Next month, ${monthLabel(model.nextMonth)}`}
      >
        <ChevronRight aria-hidden="true" />
      </PendingLink>
      {model.month !== thisMonth && (
        <PendingLink href={monthLink(thisMonth)} start={startNavigation} className={buttonClasses({ variant: "ghost", size: "sm", className: "pointer-coarse:min-h-11" })}>
          This month
        </PendingLink>
      )}
    </nav>
  );

  return (
    <>
      {/* Another month is a server render: this month stays visible, dimmed and busy, until it arrives. */}
      <Refetching pending={navigating}>
        <ChartFrame
          title="Performance calendar"
          question="When am I winning or losing?"
          headingLevel={2}
          sample={
            tradingDays
              ? `${model.closed} closed ${model.closed === 1 ? "trade" : "trades"} on ${tradingDays} ${tradingDays === 1 ? "day" : "days"} · grouped by exit day (UTC−5)`
              : "Grouped by exit day (UTC−5)"
          }
          summary={summary}
          actions={monthNav}
          table={
            <DataTable
              caption={`Performance calendar, ${monthLabel(model.month)}`}
              rows={model.days}
              rowKey={day => day.day}
              empty={<p className="t-meta">No closed trades in {monthLabel(model.month)}.</p>}
              columns={[
                {
                  key: "date",
                  header: "Day",
                  cell: day => (
                    <button type="button" className="ui-table-link text-left" data-calendar-day={day.day} aria-haspopup="dialog" onClick={openFrom(day.day)}>
                      {day.label}
                    </button>
                  ),
                },
                { key: "r", header: "Net R", align: "end", cell: day => day.rDetail },
                { key: "pnl", header: "Net P&L", align: "end", cell: day => day.money.map(entry => entry.netLabel).join(" · ") || "—" },
                { key: "loss", header: "Gross realized loss", align: "end", cell: day => day.money.map(entry => entry.lossLabel).join(" · ") || "—" },
                { key: "count", header: "Trades", align: "end", cell: day => String(day.closed) },
              ]}
            />
          }
          legend={<Legend mode={mode} dimmed={model.rangeFrom !== null || model.rangeTo !== null} />}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Field label="Calendar shows" labelHidden className="w-full sm:hidden">
              <Select value={mode} onChange={event => chooseMode(event.target.value as CalendarMode)}>
                {MODES.map(option => (
                  <option key={option.mode} value={option.mode}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset. */}
            <div className="segmented segmented-sm hidden sm:inline-flex" role="group" aria-label="Calendar shows">
              {MODES.map(option => (
                <button key={option.mode} type="button" className="segmented-label" aria-pressed={mode === option.mode} onClick={() => chooseMode(option.mode)}>
                  {option.label}
                </button>
              ))}
            </div>
            {moneyMode && model.currencies.length > 1 && (
              // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset.
              <div className="segmented segmented-sm" role="group" aria-label="Currency">
                {model.currencies.map(code => (
                  <button key={code} type="button" className="segmented-label" aria-pressed={currency === code} onClick={() => chooseCurrency(code)}>
                    {code}
                  </button>
                ))}
              </div>
            )}
            {moneyMode && model.currencies.length === 1 && <span className="t-meta">{model.currencies[0]}</span>}
          </div>
          <table className="calendar">
            <caption className="sr-only">
              Closed trades by exit day, {monthLabel(model.month)}
            </caption>
            <thead>
              <tr>
                {WEEKDAYS.map(weekday => (
                  <th key={weekday.short} scope="col" className="calendar-weekday">
                    <abbr title={weekday.long}>{weekday.short}</abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map(week => (
                <tr key={week.find(slot => slot !== null)?.date}>
                  {week.map((slot, column) => {
                    if (slot === null) {
                      return (
                        <td key={`blank-${WEEKDAYS[column].short}`} className="calendar-day">
                          <span className="calendar-blank block" />
                        </td>
                      );
                    }
                    const view = views.get(slot.date);
                    const dimmed = outside(slot.date);
                    const today = slot.date === model.today ? "true" : undefined;
                    if (!view) {
                      return (
                        <td key={slot.date} className="calendar-day">
                          <div className={cx("calendar-cell md:min-h-[5.75rem]", dimmed && "opacity-45")} data-today={today}>
                            <span className="calendar-date">{slot.day}</span>
                            {dimmed && <span className="sr-only">, outside the selected date range</span>}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={slot.date} className="calendar-day">
                        <button
                          type="button"
                          className="calendar-cell heat cursor-pointer md:min-h-[5.75rem] hover:shadow-[inset_0_0_0_1px_var(--text-3)]"
                          data-tone={view.tone}
                          data-level={view.tone ? view.level : undefined}
                          data-today={today}
                          data-calendar-day={slot.date}
                          aria-label={`${view.day.label}: ${view.spoken}. Show trades.`}
                          title={view.spoken}
                          aria-haspopup="dialog"
                          onClick={openFrom(slot.date)}
                        >
                          <span className="calendar-date">{slot.day}</span>
                          <span className="hidden w-full min-w-0 flex-col items-start gap-0.5 md:flex" aria-hidden="true">
                            <span className={cx("w-full truncate text-[0.8125rem] leading-4 num", view.muted ? "font-normal text-2" : "font-semibold")}>{view.primary}</span>
                            {view.secondary.map(line => (
                              <span key={line} className="w-full truncate text-xs leading-4 num">
                                {line}
                              </span>
                            ))}
                          </span>
                          <span className="w-full truncate text-[0.8125rem] font-bold leading-4 num md:hidden" aria-hidden="true">
                            {view.compact}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {tradingDays === 0 ? (
            <p className="t-meta mt-3">No closed trades in {monthLabel(model.month)} match the filters. Use the arrows to see other months.</p>
          ) : (
            <div className="mt-4 md:hidden">
              <ul id={listId} className="flex flex-col divide-y divide-border border-y border-border" aria-label={`Days with closed trades, ${monthLabel(model.month)}, latest first`}>
                {listed.map(view => (
                  <li key={view.day.day}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left"
                      data-calendar-day={view.day.day}
                      aria-haspopup="dialog"
                      onClick={openFrom(view.day.day)}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">{view.day.label}</span>
                        <span className="t-caption block">{view.secondary.join(" · ")}</span>
                      </span>
                      <span className={cx("shrink-0 font-semibold num", view.tone === "pos" && mode !== "COUNT" && "value-pos", view.tone === "neg" && "value-neg")}>{view.primary}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {latestFirst.length > PHONE_DAY_LIMIT && (
                <button
                  type="button"
                  className={buttonClasses({ variant: "ghost", className: "mt-1 w-full text-accent" })}
                  aria-expanded={allDays}
                  aria-controls={listId}
                  onClick={() => setAllDays(value => !value)}
                >
                  {allDays ? `Show the latest ${PHONE_DAY_LIMIT} days` : `Show all ${latestFirst.length} days`}
                </button>
              )}
            </div>
          )}
        </ChartFrame>
      </Refetching>
      <DaySheet day={shown} open={openDay !== null} multiAccount={model.multiAccount} onClose={() => setOpenDay(null)} onCloseAutoFocus={returnFocus} />
    </>
  );
}

function Legend({ mode, dimmed }: { mode: CalendarMode; dimmed: boolean }) {
  const [start, end] = LEGEND[mode];
  const levels = [1, 2, 3, 4] as const;
  const diverging = mode === "NET_R" || mode === "NET_PNL";
  const tone = mode === "COUNT" ? "seq" : "neg";
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <div className="calendar-legend" aria-hidden="true">
        <span>{start}</span>
        {diverging
          ? [...levels].reverse().map(level => <span key={`neg-${level}`} className="calendar-legend-step heat" data-tone="neg" data-level={level} />)
          : levels.map(level => <span key={`${tone}-${level}`} className="calendar-legend-step heat" data-tone={tone} data-level={level} />)}
        {diverging && (
          <>
            <span className="calendar-legend-step" />
            {levels.map(level => (
              <span key={`pos-${level}`} className="calendar-legend-step heat" data-tone="pos" data-level={level} />
            ))}
          </>
        )}
        <span>{end}</span>
      </div>
      {dimmed && <p className="t-caption">Days outside the selected date range are dimmed.</p>}
    </div>
  );
}
