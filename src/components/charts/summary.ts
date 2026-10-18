import { extremes, toDecimal } from "./scale";
import type { ChartDatum, HistogramBin } from "./types";

/** "Cumulative R: 38 points from Oct 1 to Oct 14. Latest +12.40R; highest …; lowest …." */
export function seriesSummary(name: string, points: ChartDatum[]): string {
  if (points.length === 0) return `${name}: no data yet.`;
  const last = points[points.length - 1];
  const range = extremes(points.map((point) => toDecimal(point.value)));
  if (points.length === 1 || !range) return `${name}: ${last.label} ${last.valueLabel}.`;
  const high = points[range.maxIndex];
  const low = points[range.minIndex];
  return `${name}: ${points.length} points from ${points[0].label} to ${last.label}. Latest ${last.valueLabel}; highest ${high.valueLabel} (${high.label}); lowest ${low.valueLabel} (${low.label}).`;
}

/** "OB first touch +6.80R (N = 12 · Emerging tendency)": the entry with its detail, so a group never reads without its sample. */
const describeEntry = (datum: ChartDatum) => `${datum.label} ${datum.valueLabel}${datum.detail ? ` (${datum.detail})` : ""}`;

/**
 * "Net R by model: 2 entries. Highest OB first touch +6.80R (N = 12 · Emerging tendency); lowest
 * OTE -1.35R (N = 8 · Insufficient evidence)." Each extreme carries its `detail`, which for a
 * breakdown is the group's sample size and evidence label (§13.8), as sighted readers see it.
 */
export function categorySummary(name: string, data: ChartDatum[]): string {
  if (data.length === 0) return `${name}: no data yet.`;
  const range = extremes(data.map((datum) => toDecimal(datum.value)));
  if (data.length === 1 || !range) return `${name}: ${describeEntry(data[0])}.`;
  return `${name}: ${data.length} entries. Highest ${describeEntry(data[range.maxIndex])}; lowest ${describeEntry(data[range.minIndex])}.`;
}

/** "R distribution: 24 outcomes in 8 bins; most frequent −1.0R to −0.5R (6)." */
export function histogramSummary(name: string, bins: HistogramBin[]): string {
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  if (total === 0) return `${name}: no outcomes yet.`;
  const mode = bins.reduce((best, bin) => (bin.count > best.count ? bin : best), bins[0]);
  return `${name}: ${total} ${total === 1 ? "outcome" : "outcomes"} in ${bins.length} bins; most frequent ${mode.label} (${mode.countLabel ?? mode.count}).`;
}
