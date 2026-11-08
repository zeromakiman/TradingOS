import type { ReactNode } from "react";
import type { CalendarMode } from "@/domain/performance";

/**
 * Calendar modes are the domain's (`calendarMonth` in src/domain/performance.ts), so its
 * output can be passed straight in: NET_R · NET_PNL (one currency) · GROSS_LOSS · COUNT.
 */
export type { CalendarMode };

/** Identity colours for marks (§13.1): categorical slots or the profit/loss pair. */
export type SeriesTone = "series-1" | "series-2" | "series-3" | "pos" | "neg";

/**
 * One value on a chart. `value` is a canonical decimal string (never a JavaScript number);
 * `valueLabel` is the same value already formatted by the domain formatters (formatR,
 * formatMoney), so a chart can never display a number that disagrees with the rest of the UI.
 */
export type ChartDatum = {
  /** Stable unique key; never displayed. */
  key: string;
  /** Category or x position in words: "Oct 14", "Trade 12", "OTE". */
  label: string;
  /** Null when the value is not known (for example net R without a risk basis): no mark is drawn. */
  value: string | null;
  valueLabel: string;
  /** Drill-down target (filtered Journal, the day, or the trade). */
  href?: string;
  /** Secondary text for tooltips and the table: "3 trades", "N = 12 · early sample". */
  detail?: string;
};

/** A line series. Series in one chart are aligned by index (point i of every series shares an x). */
export type LineSeries = {
  id: string;
  name: string;
  points: ChartDatum[];
  tone?: SeriesTone;
};

/**
 * One histogram bin, for example R outcomes in [−1.0, −0.5). Structurally compatible with
 * the domain's `DistributionBin` (`distributionR`), including its open-ended edge bins.
 */
export type HistogramBin = {
  /** Stable key; defaults to the bin edges. */
  key?: string;
  /** Range in words: "−1.0R to −0.5R", "Below −10.0R". */
  label: string;
  /** Inclusive lower edge (decimal string); null for an open-ended lowest bin. */
  from: string | null;
  /** Exclusive upper edge (decimal string); null for an open-ended highest bin. */
  to: string | null;
  count: number;
  /**
   * Trades exactly at 0R (break-even) among `count`; only the bin that starts at 0R can hold them (the domain's
   * `distributionR` fills it, 0 elsewhere). Break-even is neither profit nor loss, so that bin is drawn in the neutral
   * tone while it holds any, and as profit when this is 0. Required, so a consumer that maps the domain's bins cannot
   * drop it: without it a bin of winners that starts at 0R could only be drawn neutral.
   */
  breakEven: number;
  /** "3 trades"; defaults to the count, with the break-even trades named ("3 (1 at 0R)"). */
  countLabel?: string;
  href?: string;
};

/**
 * One day of a calendar month. `day` and `value` match the domain's calendar cells, so
 * `calendarMonth(...).days` can be passed as is, with details and links added. The heatmap
 * formats each value for its mode with the domain formatters (see `calendarValueLabel`).
 */
export type CalendarHeatmapDay = {
  /** Strategy day, "2026-10-14". */
  day: string;
  /** Cell value for the mode (decimal string); null on days without a result. */
  value: string | null;
  /** Secondary text for the tooltip and the table, for example "2 trades". */
  detail?: string;
  href?: string;
};

/**
 * Formats an axis tick (a canonical decimal string) for display. `step` is the distance between
 * neighbouring ticks (when the axis knows it), so a formatter can show exactly the precision
 * that keeps neighbouring labels distinct.
 */
export type TickFormatter = (value: string, step?: string) => string;

/** Empty-state copy shown instead of the chart when there is nothing to plot (§13.7). */
export type ChartEmptyCopy = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

/** Hover/focus readout for one mark. */
export type ChartTip = {
  title: string;
  rows: { value: string; label?: string; tone?: SeriesTone }[];
  note?: string;
};

/** Where a mark's tooltip points, in percent of the plot area. */
export type ChartAnchor = {
  x: number;
  y: number;
  /** Crosshair dots, one per series. */
  dots?: { y: number; tone: SeriesTone }[];
};

/** Fields shared by every chart figure. */
export type ChartFigureProps = {
  /** Chart name, for example "Cumulative R". */
  title: string;
  /** The trading question it answers (§13.6), for example "Is the process compounding?". */
  question: string;
  /** Sample size in words, for example "38 closed trades · early sample". */
  sample?: ReactNode;
  /** Text summary for assistive technology; generated from the data when omitted. */
  summary?: string;
  empty?: ChartEmptyCopy;
  /** Extra controls in the header (mode switch, month navigation). */
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
};
