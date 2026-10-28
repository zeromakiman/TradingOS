import { cx } from "../ui/cx";
import { DataTable, TableLink } from "../ui/table";
import { Gridlines, gutterStyle, XAxis, YAxis, yTicks } from "./axes";
import { ChartFrame } from "./chart-frame";
import { formatTickCount, formatTickNumber } from "./format";
import { ChartInteraction } from "./interaction";
import { ChartMark } from "./marks";
import { axisLabelSlots, bandLayout, cssVars, type Dec, extremes, LABEL_HEADROOM, labelAlign, niceScale, round, signOf, toDecimal, topPercent, ZERO } from "./scale";
import { CategoryTable } from "./category-table";
import { binCountText, categorySummary, histogramSummary, safeCount } from "./summary";
import type { ChartAnchor, ChartDatum, ChartEmptyCopy, ChartFigureProps, ChartTip, HistogramBin, TickFormatter } from "./types";

const DEFAULT_EMPTY: ChartEmptyCopy = {
  title: "Nothing to chart yet.",
  description: "Results appear here once trades are closed.",
};

type BarSign = "pos" | "neg" | "zero" | "neutral";

type Bar = { key: string; x: number; top: number; height: number; sign: BarSign };

function barGeometry(value: Dec, x: number, key: string, zero: number, scale: { min: Dec; max: Dec }, sign: BarSign = signOf(value)): Bar {
  const end = topPercent(value, scale);
  return { key, x, sign, top: round(Math.min(end, zero)), height: round(Math.abs(zero - end)) };
}

function Bars({ bars }: { bars: Bar[] }) {
  return (
    <>
      {bars.map((bar) => (
        <span key={bar.key} className="chart-bar" data-sign={bar.sign} aria-hidden="true" style={{ left: `${bar.x}%`, top: `${bar.top}%`, height: bar.sign === "zero" ? undefined : `${bar.height}%` }} />
      ))}
    </>
  );
}

export type DivergingBarChartProps = ChartFigureProps & {
  /** One bar per category (usually a strategy day), signed. */
  data: ChartDatum[];
  formatTick?: TickFormatter;
  /** Table header for the categories, for example "Day". */
  categoryLabel?: string;
  /** Name of the value, for example "Net R" or "Net P&L". */
  valueName?: string;
  size?: "md" | "lg";
};

/** Daily net R or net P&L: profit bars rise and loss bars fall from one zero baseline. */
export function DivergingBarChart({
  title,
  question,
  sample,
  summary,
  empty,
  actions,
  headingLevel,
  className,
  data,
  formatTick = formatTickNumber,
  categoryLabel = "Day",
  valueName = "Value",
  size = "md",
}: DivergingBarChartProps) {
  const resolvedSummary = summary ?? categorySummary(title, data);
  if (data.length === 0) {
    return (
      <ChartFrame title={title} question={question} sample={sample} summary={resolvedSummary} table={null} empty={empty ?? DEFAULT_EMPTY} actions={actions} headingLevel={headingLevel} className={className}>
        {null}
      </ChartFrame>
    );
  }

  const values = data.map((datum) => toDecimal(datum.value));
  const scale = niceScale(values.filter((value): value is Dec => value !== null), { includeZero: true, headroom: LABEL_HEADROOM });
  const ticks = yTicks(scale, formatTick);
  const zero = topPercent(ZERO, scale);
  const { band, centers } = bandLayout(data.length);
  const bars = data.flatMap((datum, index) => {
    const value = values[index];
    return value === null ? [] : [barGeometry(value, centers[index], datum.key, zero, scale)];
  });
  const range = extremes(values);
  const tips: ChartTip[] = data.map((datum) => ({ title: datum.label, rows: [{ value: datum.valueLabel, label: valueName }], note: datum.detail }));
  const anchors: ChartAnchor[] = data.map((_, index) => {
    const value = values[index];
    return { x: centers[index], y: value === null ? zero : Math.min(zero, topPercent(value, scale)) };
  });

  // Direct labels only on the extremes: the best day above its bar, the worst below it.
  const labelled = range
    ? [
        { index: range.maxIndex, placement: "above" as const },
        { index: range.minIndex, placement: "below" as const },
      ].filter(({ index, placement }) => {
        const value = values[index];
        return value !== null && (placement === "above" ? value.gt(0) : value.lt(0));
      })
    : [];

  return (
    <ChartFrame
      title={title}
      question={question}
      sample={sample}
      summary={resolvedSummary}
      table={<CategoryTable caption={title} categoryLabel={categoryLabel} valueName={valueName} data={data} />}
      actions={actions}
      headingLevel={headingLevel}
      className={className}
    >
      <div className={cx("chart", size === "lg" && "chart-lg")} style={gutterStyle(ticks)}>
        <div className="chart-body">
          <YAxis scale={scale} ticks={ticks} />
          <ChartInteraction className="chart-canvas" tips={tips} anchors={anchors} style={cssVars({ "--band": `${band}%` })}>
            <Gridlines scale={scale} />
            <Bars bars={bars} />
            {labelled.map(({ index, placement }) => {
              const value = values[index];
              if (value === null) return null;
              const end = topPercent(value, scale);
              return (
                <span key={`label-${placement}`} className="chart-direct-label" data-placement={placement} data-align={labelAlign(centers[index])} style={{ left: `${centers[index]}%`, top: `${end}%` }} aria-hidden="true">
                  {data[index].valueLabel}
                </span>
              );
            })}
            <ul className="chart-hits" aria-label={`${title}: bars. Use the arrow keys to move between them.`}>
              {data.map((datum, index) => (
                <li key={datum.key}>
                  <ChartMark index={index} tip={tips[index]} href={datum.href} focusable={index === 0} style={{ left: `${round(index * band)}%`, width: `${band}%` }} />
                </li>
              ))}
            </ul>
          </ChartInteraction>
        </div>
        <XAxis labels={axisLabelSlots(data.length).map((slot) => ({ key: data[slot.index].key, text: data[slot.index].label, x: centers[slot.index], minor: slot.minor }))} />
      </div>
    </ChartFrame>
  );
}

export type HistogramProps = ChartFigureProps & {
  /** Contiguous bins in ascending order (for R: 0.5R wide). */
  bins: HistogramBin[];
  /** Formats bin edges on the x axis (for R, `formatTickR`). */
  formatEdge?: TickFormatter;
  /** Table header for the bin ranges. */
  binLabel?: string;
  /** Table header for the counts. */
  countName?: string;
  size?: "md" | "lg";
};

const binKey = (bin: HistogramBin) => bin.key ?? `${bin.from ?? "open"}:${bin.to ?? "open"}`;

/** Narrowest width among the closed bins (the spacing of the edge labels); undefined when no bin is closed. */
function binWidth(bins: HistogramBin[]): string | undefined {
  let narrowest: Dec | null = null;
  for (const bin of bins) {
    const from = toDecimal(bin.from);
    const to = toDecimal(bin.to);
    if (!from || !to?.gt(from)) continue;
    const width = to.minus(from);
    if (!narrowest || width.lt(narrowest)) narrowest = width;
  }
  return narrowest?.toFixed();
}

/**
 * Bins entirely below zero are losses and bins entirely above zero profits. A bin spanning zero is neutral, and so is
 * the bin that starts at 0R (`[0, 0.5)`) while it holds break-even trades: exactly 0R is neither profit nor loss. With
 * none (`breakEven: 0`) it holds only winners and is profit; an unreadable count stays neutral.
 */
export function binSign(bin: Pick<HistogramBin, "from" | "to" | "breakEven">): BarSign {
  const from = toDecimal(bin.from);
  const to = toDecimal(bin.to);
  if (to?.lte(0)) return "neg";
  if (from?.gt(0)) return "pos";
  if (from?.isZero()) return bin.breakEven === 0 ? "pos" : "neutral";
  return "neutral";
}

export { binCountText };

/** Distribution of outcomes per bin (for R: "How are outcomes distributed?"). */
export function Histogram({
  title,
  question,
  sample,
  summary,
  empty,
  actions,
  headingLevel,
  className,
  bins,
  formatEdge = formatTickNumber,
  binLabel = "Range",
  countName = "Trades",
  size = "md",
}: HistogramProps) {
  const resolvedSummary = summary ?? histogramSummary(title, bins);
  const total = bins.reduce((sum, bin) => sum + safeCount(bin.count), 0);
  if (bins.length === 0 || total === 0) {
    return (
      <ChartFrame title={title} question={question} sample={sample} summary={resolvedSummary} table={null} empty={empty ?? DEFAULT_EMPTY} actions={actions} headingLevel={headingLevel} className={className}>
        {null}
      </ChartFrame>
    );
  }

  const counts = bins.map((bin) => toDecimal(String(safeCount(bin.count))) ?? ZERO);
  const scale = niceScale(counts, { includeZero: true, integer: true, flat: { min: "0", max: "1" }, headroom: LABEL_HEADROOM });
  const ticks = yTicks(scale, formatTickCount);
  const zero = topPercent(ZERO, scale);
  const { band, centers } = bandLayout(bins.length);
  const bars = bins.map((bin, index) => barGeometry(counts[index], centers[index], binKey(bin), zero, scale, counts[index].isZero() ? "zero" : binSign(bin)));
  const mode = extremes(counts)?.maxIndex ?? 0;
  const countText = binCountText;
  const tips: ChartTip[] = bins.map((bin) => ({ title: bin.label, rows: [{ value: countText(bin), label: countName }] }));
  const anchors: ChartAnchor[] = bars.map((bar) => ({ x: bar.x, y: bar.top }));
  // Bin edges along the axis. An open-ended bin has no number at its outer edge, so labels are
  // chosen among the finite edges (the first and last of those stay visible on small screens).
  const edges = [...bins.map((bin) => bin.from), bins[bins.length - 1].to].flatMap((edge, position) => (edge === null ? [] : [{ edge, position }]));
  const edgeStep = binWidth(bins);
  const edgeLabels = axisLabelSlots(edges.length, 8).map((slot) => {
    const { edge, position } = edges[slot.index];
    return { key: `edge-${position}`, text: formatEdge(edge, edgeStep), x: round(position * band), minor: slot.minor };
  });

  return (
    <ChartFrame
      title={title}
      question={question}
      sample={sample}
      summary={resolvedSummary}
      table={
        <DataTable
          caption={title}
          rows={bins}
          rowKey={binKey}
          columns={[
            { key: "range", header: binLabel, cell: (bin) => (bin.href ? <TableLink href={bin.href}>{bin.label}</TableLink> : bin.label) },
            { key: "count", header: countName, align: "end", cell: countText },
          ]}
        />
      }
      actions={actions}
      headingLevel={headingLevel}
      className={className}
    >
      <div className={cx("chart", size === "lg" && "chart-lg")} style={gutterStyle(ticks)}>
        <div className="chart-body">
          <YAxis scale={scale} ticks={ticks} />
          <ChartInteraction className="chart-canvas" tips={tips} anchors={anchors} style={cssVars({ "--band": `${band}%` })}>
            <Gridlines scale={scale} />
            <Bars bars={bars} />
            <span className="chart-direct-label" data-placement="above" data-align={labelAlign(centers[mode])} style={{ left: `${centers[mode]}%`, top: `${bars[mode].top}%` }} aria-hidden="true">
              {countText(bins[mode])}
            </span>
            <ul className="chart-hits" aria-label={`${title}: bins. Use the arrow keys to move between them.`}>
              {bins.map((bin, index) => (
                <li key={binKey(bin)}>
                  <ChartMark index={index} tip={tips[index]} href={bin.href} focusable={index === 0} style={{ left: `${round(index * band)}%`, width: `${band}%` }} />
                </li>
              ))}
            </ul>
          </ChartInteraction>
        </div>
        <XAxis labels={edgeLabels} />
      </div>
    </ChartFrame>
  );
}
