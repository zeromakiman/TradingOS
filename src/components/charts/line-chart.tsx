import { formatR } from "@/domain/format";
import { cx } from "../ui/cx";
import { DataTable, TableLink } from "../ui/table";
import { Gridlines, gutterStyle, XAxis, YAxis, yTicks } from "./axes";
import { ChartFrame } from "./chart-frame";
import { formatTickNumber } from "./format";
import { ChartInteraction } from "./interaction";
import { ChartMark } from "./marks";
import {
  areaPath,
  axisLabelSlots,
  type Dec,
  extremes,
  LABEL_HEADROOM,
  LABEL_ROOM,
  labelAlign,
  linePath,
  niceScale,
  pointHitAreas,
  pointPositions,
  SVG_VIEWBOX,
  toDecimal,
  topPercent,
  ZERO,
} from "./scale";
import { seriesSummary } from "./summary";
import { decimatePath, deepestFall, everyNth, MARK_LIMIT, markedPositions } from "./thinning";
import { SERIES_ORDER, seriesClass } from "./tones";
import type { ChartAnchor, ChartDatum, ChartEmptyCopy, ChartFigureProps, ChartTip, LineSeries, SeriesTone, TickFormatter } from "./types";

const DEFAULT_EMPTY: ChartEmptyCopy = {
  title: "Nothing to chart yet.",
  description: "Results appear here once trades are closed.",
};

export type LineChartProps = ChartFigureProps & {
  /**
   * Series aligned by index. Up to three are drawn (more would not stay distinguishable,
   * §13.1); fold the rest into fewer series or facet them, or they appear in the table only.
   */
  series: LineSeries[];
  /** Header of the x column in the table view, for example "Trade" or "Date". */
  xLabel?: string;
  formatTick?: TickFormatter;
  /** Keep zero in the domain (default). Turn off for balances, which never start at zero. */
  includeZero?: boolean;
  /** 10% area wash under a single series (default on for one series). */
  area?: boolean;
  size?: "md" | "lg";
};

type Variant = "line" | "drawdown";
type Point = { x: number; y: number };

/** Cumulative R, balance from trades, or any value over an ordered sequence (crosshair readout). */
export function LineChart(props: LineChartProps) {
  return <LineFigure {...props} variant="line" />;
}

/** A drawdown point: the chart formats its value, so labels always match the plotted sign. */
export type DrawdownPoint = Omit<ChartDatum, "valueLabel">;

export type DrawdownChartProps = Omit<LineChartProps, "series" | "includeZero" | "area"> & {
  /**
   * Drawdown at each point, zero at a new peak, in either sign convention: the domain's
   * `drawdownR` (distance below the peak, ≥ 0) can be passed as is, or a signed value (≤ 0).
   * The magnitude is always plotted below zero.
   */
  points: DrawdownPoint[];
  /** Formats the signed drawdown (≤ 0) for labels, tooltips and the table; R by default (`formatR`). */
  formatValue?: (signed: string) => string;
  name?: string;
};

function belowZero(value: string | null): string | null {
  const decimal = toDecimal(value);
  if (decimal === null) return null;
  return decimal.isZero() ? "0" : decimal.abs().neg().toFixed();
}

/** R drawdown below zero, answering "Where am I giving profits back?". */
export function DrawdownChart({ points, formatValue = formatR, name = "R drawdown", ...props }: DrawdownChartProps) {
  const plotted = points.map((point): ChartDatum => {
    const value = belowZero(point.value);
    return { ...point, value, valueLabel: value === null ? "—" : formatValue(value) };
  });
  return <LineFigure {...props} series={[{ id: "drawdown", name, points: plotted, tone: "neg" }]} variant="drawdown" includeZero />;
}

/** Splits a series at missing values so gaps stay gaps. */
function segments(points: (Point | null)[]): Point[][] {
  const runs: Point[][] = [[]];
  for (const point of points) {
    if (point) runs[runs.length - 1].push(point);
    else if (runs[runs.length - 1].length > 0) runs.push([]);
  }
  return runs.filter((run) => run.length > 0);
}

/** The deepest point of a drawdown (≤ 0) series, the one `DeepestPoint` labels; null while it never goes below zero. */
function deepestBelowZero(values: (Dec | null)[]): number | null {
  const range = extremes(values);
  return range && values[range.minIndex]?.isNegative() ? range.minIndex : null;
}

function LineFigure({
  title,
  question,
  sample,
  summary,
  empty,
  actions,
  headingLevel,
  className,
  series: input,
  xLabel = "Point",
  formatTick = formatTickNumber,
  includeZero = true,
  area,
  size = "md",
  variant,
}: LineChartProps & { variant: Variant }) {
  // At most three series stay distinguishable (§13.1); further series are listed in the table only.
  const series = input.slice(0, SERIES_ORDER.length).map((line, position) => ({ ...line, tone: line.tone ?? SERIES_ORDER[position] }));
  const count = Math.max(0, ...series.map((line) => line.points.length));
  const values = series.map((line) => line.points.map((point) => toDecimal(point.value)));
  const multiple = series.length > 1;
  const resolvedSummary = summary ?? input.map((line) => seriesSummary(line.name, line.points)).join(" ");

  if (count === 0) {
    return (
      <ChartFrame title={title} question={question} sample={sample} summary={resolvedSummary} table={null} empty={empty ?? DEFAULT_EMPTY} actions={actions} headingLevel={headingLevel} className={className}>
        {null}
      </ChartFrame>
    );
  }

  const scale = niceScale(
    values.flat().filter((value): value is Dec => value !== null),
    variant === "drawdown" ? { includeZero: true, flat: { min: "-1", max: "0" }, headroom: LABEL_HEADROOM } : { includeZero, headroom: LABEL_HEADROOM },
  );
  const ticks = yTicks(scale, formatTick);
  const xs = pointPositions(count);
  const baseline = includeZero ? topPercent(ZERO, scale) : 100;
  const showArea = !multiple && (area ?? true);
  const tops = values.map((line) => line.map((value) => (value === null ? null : topPercent(value, scale))));

  // Long series (above MARK_LIMIT points) keep marks, tooltips and table rows only for the marked points, and draw
  // min/max-decimated paths (thinning.ts); shorter ones keep every point.
  const thinned = count > MARK_LIMIT;
  const deepest = thinned ? values.map((line) => (variant === "drawdown" ? deepestBelowZero(line) : deepestFall(line))) : [];
  const positions = markedPositions(count, deepest);
  const tableNote = thinned
    ? `${everyNth(count)}, with the first point${deepest.some((position) => position !== null) ? " and the deepest drawdown" : ""}. The Journal lists every trade.`
    : undefined;

  const paths = series.map((line, index) => {
    const runs = segments(tops[index].map((y, position) => (y === null ? null : { x: xs[position], y })));
    const drawn = thinned ? runs.map((run) => decimatePath(run)) : runs;
    return {
      id: line.id,
      tone: line.tone,
      line: drawn.map((run) => linePath(run)).filter(Boolean).join(" "),
      area: showArea ? drawn.map((run) => areaPath(run, baseline)).filter(Boolean).join(" ") : "",
      // A point between two gaps has no segment, so it is drawn as a dot (EndMarks draws the last run's end).
      isolated: runs.slice(0, -1).filter((run) => run.length === 1).map((run) => run[0]),
    };
  });

  // Mark `mark` (its `data-mark`, its tooltip and anchor) is the point at `positions[mark]`.
  const tips: ChartTip[] = positions.map((position) => ({
    title: series[0].points[position]?.label ?? "",
    rows: series.map((line) => ({
      value: line.points[position]?.valueLabel ?? "—",
      label: multiple ? line.name : undefined,
      tone: multiple ? line.tone : undefined,
    })),
    note: multiple ? undefined : series[0].points[position]?.detail,
  }));

  const anchors: ChartAnchor[] = positions.map((position) => {
    const dots = series.flatMap((line, index) => {
      const y = tops[index][position];
      return y === null ? [] : [{ y, tone: line.tone }];
    });
    return { x: xs[position], y: dots.length > 0 ? Math.min(...dots.map((dot) => dot.y)) : baseline, dots };
  });

  const hrefAt = (mark: number) => {
    const position = positions[mark];
    return series.find((line) => line.points[position]?.href)?.points[position]?.href;
  };
  const hits = pointHitAreas(positions.map((position) => xs[position]));

  return (
    <ChartFrame
      title={title}
      question={question}
      sample={sample}
      summary={resolvedSummary}
      table={<LineTable caption={title} xLabel={xLabel} series={input} marked={tableNote === undefined ? undefined : { positions, note: tableNote }} />}
      legend={multiple ? <SeriesLegend series={series} tableOnly={input.length - series.length} /> : undefined}
      actions={actions}
      headingLevel={headingLevel}
      className={className}
    >
      <div className={cx("chart", size === "lg" && "chart-lg")} style={gutterStyle(ticks)}>
        <div className="chart-body">
          <YAxis scale={scale} ticks={ticks} />
          <ChartInteraction className="chart-canvas" tips={tips} anchors={anchors} crosshair>
            <Gridlines scale={scale} />
            <svg className="chart-svg" viewBox={SVG_VIEWBOX} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {paths.map((path) => (
                <g key={path.id} className={seriesClass(path.tone)}>
                  {path.area && <path className={cx("chart-area", variant === "drawdown" && "chart-area-strong")} d={path.area} />}
                  {path.line && <path className="chart-line" d={path.line} />}
                </g>
              ))}
            </svg>
            {paths.flatMap((path) =>
              path.isolated.map((point) => (
                <span key={`${path.id}-${point.x}`} className={cx("chart-dot", seriesClass(path.tone))} style={{ left: `${point.x}%`, top: `${point.y}%` }} aria-hidden="true" />
              )),
            )}
            <EndMarks series={series} values={values} tops={tops} xs={xs} variant={variant} />
            {variant === "drawdown" && <DeepestPoint points={series[0].points} values={values[0]} tops={tops[0]} xs={xs} />}
            <ul className="chart-hits" aria-label={`${title}: ${thinned ? everyNth(count).toLowerCase() : "data points"}. Use the arrow keys to move between them.`}>
              {hits.map((hit, mark) => (
                <li key={series[0].points[positions[mark]]?.key ?? `point-${hit.left}`}>
                  <ChartMark index={mark} tip={tips[mark]} href={hrefAt(mark)} focusable={mark === positions.length - 1} style={{ left: `${hit.left}%`, width: `${hit.width}%` }} />
                </li>
              ))}
            </ul>
          </ChartInteraction>
        </div>
        <XAxis
          labels={axisLabelSlots(count).map((slot) => ({
            key: series[0].points[slot.index]?.key ?? `x-${slot.index}`,
            text: series[0].points[slot.index]?.label ?? "",
            x: xs[slot.index],
            minor: slot.minor,
          }))}
        />
      </div>
    </ChartFrame>
  );
}

type EndMarksProps = {
  series: (LineSeries & { tone: SeriesTone })[];
  values: (Dec | null)[][];
  tops: (number | null)[][];
  xs: number[];
  variant: Variant;
};

/**
 * End-point dots and direct labels, only where they cannot collide: a label sits on the side
 * away from the segment arriving at the end point, and converging end labels are left to the
 * legend and tooltip. A drawdown back at its peak (zero) needs no label.
 */
function EndMarks({ series, values, tops, xs, variant }: EndMarksProps) {
  const ends = series.flatMap((line, index) => {
    const position = tops[index].findLastIndex((y) => y !== null);
    const y = position >= 0 ? tops[index][position] : null;
    if (y === null) return [];
    const previous = position > 0 ? tops[index][position - 1] : null;
    const arrivesFromAbove = previous !== null && previous < y;
    const placement: "above" | "below" = y < LABEL_ROOM || (arrivesFromAbove && y <= 100 - LABEL_ROOM) ? "below" : "above";
    const labelled = !(variant === "drawdown" && values[index][position]?.isZero());
    return [{ id: line.id, tone: line.tone, x: xs[position], y, placement, labelled, text: line.points[position].valueLabel }];
  });
  const separated = (end: (typeof ends)[number]) => ends.every((other) => other.id === end.id || Math.abs(other.y - end.y) >= 10);
  return (
    <>
      {ends.map((end) => (
        <span key={`dot-${end.id}`} className={cx("chart-dot", seriesClass(end.tone))} style={{ left: `${end.x}%`, top: `${end.y}%` }} aria-hidden="true" />
      ))}
      {ends
        .filter((end) => end.labelled && separated(end))
        .map((end) => (
          <span
            key={`label-${end.id}`}
            className="chart-direct-label"
            data-placement={end.placement}
            data-align={labelAlign(end.x)}
            style={{ left: `${end.x}%`, top: `${end.y}%` }}
            aria-hidden="true"
          >
            {end.text}
          </span>
        ))}
    </>
  );
}

/** Labels the deepest drawdown, the extreme the drawdown chart is about. */
function DeepestPoint({ points, values, tops, xs }: { points: ChartDatum[]; values: (Dec | null)[]; tops: (number | null)[]; xs: number[] }) {
  const range = extremes(values);
  if (!range) return null;
  const deepest = values[range.minIndex];
  const y = tops[range.minIndex];
  if (!deepest || deepest.isZero() || y === null || range.minIndex === points.length - 1) return null;
  return (
    <span className="chart-direct-label" data-placement={y > 100 - LABEL_ROOM ? "above" : "below"} data-align={labelAlign(xs[range.minIndex])} style={{ left: `${xs[range.minIndex]}%`, top: `${y}%` }} aria-hidden="true">
      {points[range.minIndex].valueLabel}
    </span>
  );
}

function SeriesLegend({ series, tableOnly }: { series: (LineSeries & { tone: SeriesTone })[]; tableOnly: number }) {
  return (
    <ul className="chart-legend" aria-label="Series">
      {series.map((line) => (
        <li key={line.id} className={cx("chart-legend-item", seriesClass(line.tone))}>
          <span className="chart-legend-line" aria-hidden="true" />
          {line.name}
        </li>
      ))}
      {tableOnly > 0 && <li className="chart-legend-item">{`+${tableOnly} more series in the table`}</li>}
    </ul>
  );
}

/**
 * Every series by position, including any beyond the three that are drawn. A thinned chart lists only its marked
 * positions (`marked`) and says so in a visible caption (every line chart in the app plots closed trades, which the
 * Journal lists in full).
 */
function LineTable({ caption, xLabel, series, marked }: { caption: string; xLabel: string; series: LineSeries[]; marked?: { positions: number[]; note: string } }) {
  const count = Math.max(0, ...series.map((line) => line.points.length));
  const rows = marked?.positions ?? Array.from({ length: count }, (_, position) => position);
  const hasDetail = series.length === 1 && series[0].points.some((point) => point.detail);
  return (
    <DataTable
      caption={
        marked ? (
          <>
            <span className="sr-only">{`${caption}. `}</span>
            <span className="t-caption font-normal">{marked.note}</span>
          </>
        ) : (
          caption
        )
      }
      captionVisible={marked !== undefined}
      rows={rows}
      rowKey={(position) => series[0].points[position]?.key ?? `row-${position}`}
      columns={[
        {
          key: "x",
          header: xLabel,
          cell: (position) => {
            const point = series.find((line) => line.points[position]?.href)?.points[position] ?? series[0].points[position];
            if (!point) return "—";
            return point.href ? <TableLink href={point.href}>{point.label}</TableLink> : point.label;
          },
        },
        ...series.map((line) => ({
          key: line.id,
          header: line.name,
          align: "end" as const,
          cell: (position: number) => line.points[position]?.valueLabel ?? "—",
        })),
        ...(hasDetail ? [{ key: "detail", header: "Details", cell: (position: number) => series[0].points[position]?.detail ?? "" }] : []),
      ]}
    />
  );
}
