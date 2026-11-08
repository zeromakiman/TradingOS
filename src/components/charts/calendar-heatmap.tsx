import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatMoney, formatR, formatSignedMoney } from "@/domain/format";
import { buttonClasses } from "../ui/button";
import { type SegmentedLink, SegmentedLinks } from "../ui/choice";
import { DataTable, TableLink } from "../ui/table";
import { type CalendarSlot, longDayLabel, monthLabel, monthWeeks, shortDayLabel, WEEKDAYS } from "./calendar";
import { ChartFrame } from "./chart-frame";
import { ChartInteraction } from "./interaction";
import { ChartMark } from "./marks";
import { type Dec, extremes, intensityLevel, toDecimal, ZERO } from "./scale";
import type { CalendarHeatmapDay, CalendarMode, ChartFigureProps, ChartTip } from "./types";

export type MonthLink = { href: string; label: string };

/**
 * The calendar mode and what formatting it needs: money modes are one currency at a time (money
 * is never mixed across currencies, §9.3), so they name it.
 */
export type CalendarValueFormat = { mode: "NET_R" | "COUNT"; currency?: string } | { mode: "NET_PNL" | "GROSS_LOSS"; currency: string };

/**
 * A day's value in the words of its mode, always through the domain formatters (§6.6): Net R
 * "+1.20R", net P&L "+$120.00", gross realized loss "$50.00", trade count "3 trades".
 */
export function calendarValueLabel(value: Dec, format: CalendarValueFormat): string {
  // Decimal keeps the sign of zero ("-0"); a zero result reads as plain zero.
  const exact = value.isZero() ? "0" : value.toFixed();
  switch (format.mode) {
    case "NET_R":
      return formatR(exact);
    case "NET_PNL":
      return formatSignedMoney(exact, format.currency);
    case "GROSS_LOSS":
      return formatMoney(exact, format.currency);
    case "COUNT":
      return `${exact} ${value.eq(1) ? "trade" : "trades"}`;
  }
}

export type CalendarHeatmapProps = Omit<ChartFigureProps, "empty"> &
  CalendarValueFormat & {
    /** "2026-10". */
    month: string;
    /** Days with data (strategy days); missing days and days of other months count as no result. */
    days: CalendarHeatmapDay[];
    /** Mode switch as links (URL state): Net R · Net P&L · Gross realized loss · Trade count. */
    modeLinks?: SegmentedLink[];
    previousMonth?: MonthLink;
    nextMonth?: MonthLink;
    /** Current strategy day, outlined. */
    today?: string;
    /** Name of the value for the table and tooltips, for example "Net R". */
    valueName?: string;
    /** Shown under the grid when no day has a result. */
    emptyNote?: string;
  };

/** A day of the month with a result: its parsed value and that value in words. */
type ResultDay = { day: CalendarHeatmapDay; value: Dec; label: string };

type CellTone = "pos" | "neg" | "seq";

const isDiverging = (mode: CalendarMode) => mode === "NET_R" || mode === "NET_PNL";

/** Net modes diverge around zero (profit/loss colours); loss and count are one-hue magnitudes. */
function toneOf(mode: CalendarMode, value: Dec | null): CellTone | undefined {
  if (value === null || value.isZero()) return undefined;
  if (isDiverging(mode)) return value.isNegative() ? "neg" : "pos";
  return mode === "GROSS_LOSS" ? "neg" : "seq";
}

const summaryWords: Record<CalendarMode, { high: string; low?: string }> = {
  NET_R: { high: "best", low: "worst" },
  NET_PNL: { high: "best", low: "worst" },
  GROSS_LOSS: { high: "largest loss" },
  COUNT: { high: "busiest" },
};

/**
 * Short non-colour cue for narrow cells, where the full value does not fit (below 768px): the
 * sign of a net result, a minus for a loss day, or the trade count. The tooltip, the mark's
 * accessible name and the table carry the full value.
 */
function cellCue(mode: CalendarMode, value: Dec): string {
  if (mode === "COUNT") return value.toFixed();
  if (value.isZero()) return "0";
  if (mode === "GROSS_LOSS") return "−";
  return value.isNegative() ? "−" : "+";
}

function calendarSummary(month: string, mode: CalendarMode, results: ResultDay[]) {
  if (results.length === 0) return `${monthLabel(month)}: no results recorded.`;
  const range = extremes(results.map((result) => result.value));
  const words = summaryWords[mode];
  const describe = (index: number) => `${shortDayLabel(results[index].day.day)} ${results[index].label}`;
  const parts = [`${monthLabel(month)}: ${results.length} ${results.length === 1 ? "day" : "days"} with results`];
  if (range) {
    parts.push(`${words.high} ${describe(range.maxIndex)}`);
    if (words.low && range.minIndex !== range.maxIndex) parts.push(`${words.low} ${describe(range.minIndex)}`);
  }
  return `${parts.join("; ")}.`;
}

/** Month calendar coloured by Net R, Net P&L (one currency), gross realized loss or trade count. */
export function CalendarHeatmap(props: CalendarHeatmapProps) {
  const {
    title,
    question,
    sample,
    summary,
    actions,
    headingLevel,
    className,
    month,
    days,
    mode,
    modeLinks,
    previousMonth,
    nextMonth,
    today,
    valueName = "Value",
    emptyNote = "No closed trades this month.",
  } = props;
  const weeks = monthWeeks(month);
  const inMonth = days.filter((day) => day.day.startsWith(`${month}-`));
  const byDate = new Map(inMonth.map((day) => [day.day, day]));
  const results = inMonth
    .flatMap((day): ResultDay[] => {
      const value = toDecimal(day.value);
      return value === null ? [] : [{ day, value, label: calendarValueLabel(value, props) }];
    })
    .sort((a, b) => a.day.day.localeCompare(b.day.day));
  const resultByDate = new Map(results.map((result) => [result.day.day, result]));
  const maxAbs = results.reduce<Dec>((max, { value }) => (value.abs().gt(max) ? value.abs() : max), ZERO);
  const slots = weeks.flat().filter((slot): slot is NonNullable<CalendarSlot> => slot !== null);
  const indexByDate = new Map(slots.map((slot, index) => [slot.date, index]));
  const focusDate = today && indexByDate.has(today) ? today : slots[0].date;

  const tips: ChartTip[] = slots.map((slot) => {
    const result = resultByDate.get(slot.date);
    return {
      title: longDayLabel(slot.date),
      rows: [result ? { value: result.label, label: valueName } : { value: "No result" }],
      note: byDate.get(slot.date)?.detail,
    };
  });

  const resolvedSummary = summary ?? calendarSummary(month, mode, results);
  const hasResults = results.length > 0;

  return (
    <ChartFrame
      title={title}
      question={question}
      sample={sample}
      summary={resolvedSummary}
      table={
        <DataTable
          caption={`${title}, ${monthLabel(month)}`}
          rows={results}
          rowKey={({ day }) => day.day}
          empty={<p className="t-meta">{emptyNote}</p>}
          columns={[
            { key: "date", header: "Date", cell: ({ day }) => (day.href ? <TableLink href={day.href}>{shortDayLabel(day.day)}</TableLink> : shortDayLabel(day.day)) },
            { key: "value", header: valueName, align: "end", cell: ({ label }) => label },
            { key: "detail", header: "Details", cell: ({ day }) => day.detail ?? "" },
          ]}
        />
      }
      legend={<CalendarLegend mode={mode} />}
      actions={
        <>
          {actions}
          {modeLinks && modeLinks.length > 0 && <SegmentedLinks label="Calendar mode" items={modeLinks} size="sm" />}
          <MonthNavigation month={month} previous={previousMonth} next={nextMonth} />
        </>
      }
      headingLevel={headingLevel}
      className={className}
    >
      <ChartInteraction tips={tips} columns={7}>
        <table className="calendar">
          <caption className="sr-only">
            {title}, {monthLabel(month)}
          </caption>
          <thead>
            <tr>
              {WEEKDAYS.map((weekday) => (
                <th key={weekday.short} scope="col" className="calendar-weekday">
                  <abbr title={weekday.long}>{weekday.short}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week.find((slot) => slot !== null)?.date}>
                {week.map((slot, column) => {
                  if (slot === null) {
                    return (
                      <td key={`blank-${WEEKDAYS[column].short}`} className="calendar-day">
                        <span className="calendar-blank" />
                      </td>
                    );
                  }
                  const index = indexByDate.get(slot.date) ?? 0;
                  const result = resultByDate.get(slot.date);
                  const tone = toneOf(mode, result?.value ?? null);
                  return (
                    <td key={slot.date} className="calendar-day">
                      <ChartMark
                        index={index}
                        tip={tips[index]}
                        href={byDate.get(slot.date)?.href}
                        focusable={slot.date === focusDate}
                        className="calendar-cell heat"
                        data={{ "data-tone": tone, "data-level": tone && result ? intensityLevel(result.value, maxAbs) : undefined, "data-today": slot.date === today ? "true" : undefined }}
                      >
                        <span className="calendar-date">{slot.day}</span>
                        {result && (
                          <>
                            <span className="calendar-value">{result.label}</span>
                            <span className="calendar-cue" aria-hidden="true">
                              {cellCue(mode, result.value)}
                            </span>
                          </>
                        )}
                      </ChartMark>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ChartInteraction>
      {!hasResults && <p className="t-meta mt-2">{emptyNote}</p>}
    </ChartFrame>
  );
}

function MonthNavigation({ month, previous, next }: { month: string; previous?: MonthLink; next?: MonthLink }) {
  if (!previous && !next) return null;
  const iconLink = (link: MonthLink | undefined, direction: "previous" | "next") => {
    const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
    const label = link?.label ?? (direction === "previous" ? "Previous month" : "Next month");
    if (!link) return <span className={buttonClasses({ variant: "ghost", size: "sm", iconOnly: true, className: "invisible" })} aria-hidden="true" />;
    return (
      <Link href={link.href} className={buttonClasses({ variant: "ghost", size: "sm", iconOnly: true })} aria-label={label} scroll={false}>
        <Icon aria-hidden="true" />
      </Link>
    );
  };
  return (
    <nav className="calendar-nav" aria-label="Month">
      {iconLink(previous, "previous")}
      <span className="calendar-month">{monthLabel(month)}</span>
      {iconLink(next, "next")}
    </nav>
  );
}

const legendWords: Record<CalendarMode, [string, string]> = {
  NET_R: ["Loss", "Profit"],
  NET_PNL: ["Loss", "Profit"],
  GROSS_LOSS: ["Smaller loss", "Larger loss"],
  COUNT: ["Fewer trades", "More trades"],
};

function CalendarLegend({ mode }: { mode: CalendarMode }) {
  const [start, end] = legendWords[mode];
  const levels = [1, 2, 3, 4] as const;
  const diverging = isDiverging(mode);
  const tone = mode === "COUNT" ? "seq" : "neg";
  return (
    <div className="calendar-legend mt-2" aria-hidden="true">
      <span>{start}</span>
      {diverging
        ? [...levels].reverse().map((level) => <span key={`neg-${level}`} className="calendar-legend-step heat" data-tone="neg" data-level={level} />)
        : levels.map((level) => <span key={`${tone}-${level}`} className="calendar-legend-step heat" data-tone={tone} data-level={level} />)}
      {diverging && (
        <>
          <span className="calendar-legend-step" />
          {levels.map((level) => (
            <span key={`pos-${level}`} className="calendar-legend-step heat" data-tone="pos" data-level={level} />
          ))}
        </>
      )}
      <span>{end}</span>
    </div>
  );
}
