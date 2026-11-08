import type { Dec } from "./scale";

/**
 * Long line series (an account with thousands of closed trades) stay light. Above `MARK_LIMIT` points a line chart keeps
 * a hover, focus and link mark, a tooltip and a table row only for the marked points (`markedPositions`), and draws its
 * line and area through the first, last, lowest and highest vertex of each of `PATH_BUCKETS` x-buckets
 * (`decimatePath`), so every swing and the deepest drawdown stay drawn at any width. Up to `MARK_LIMIT` points every
 * point keeps all of them, exactly as before.
 */
export const MARK_LIMIT = 300;

/** About one bucket per pixel column of a wide chart (the plot is at most about 900px wide). */
export const PATH_BUCKETS = 600;

/** Points per run when thinned: one mark per run of this many points (1 when nothing is thinned). */
export function markStride(count: number): number {
  return count > MARK_LIMIT ? Math.ceil(count / MARK_LIMIT) : 1;
}

/**
 * Positions (ascending, unique) that keep a mark: every position up to `MARK_LIMIT` points; above it the last point of
 * each run of `markStride(count)` points, the first point, the last point, and the `keep` positions (the deepest
 * drawdown of each series). Mark `i` of the chart is the point at `positions[i]`.
 */
export function markedPositions(count: number, keep: readonly (number | null | undefined)[] = []): number[] {
  if (count <= 0) return [];
  const stride = markStride(count);
  if (stride === 1) return Array.from({ length: count }, (_, position) => position);
  const marked = new Set<number>([0, count - 1]);
  for (let end = stride - 1; end < count; end += stride) marked.add(end);
  for (const position of keep) if (typeof position === "number" && Number.isInteger(position) && position >= 0 && position < count) marked.add(position);
  return [...marked].sort((a, b) => a - b);
}

/**
 * Position of the lowest point of the largest fall below a running peak (the trough of the maximum drawdown of a
 * cumulative R or balance line), compared exactly; null when the series never falls. Missing values are skipped.
 */
export function deepestFall(values: readonly (Dec | null)[]): number | null {
  let peak: Dec | null = null;
  let largest: Dec | null = null;
  let trough: number | null = null;
  for (let position = 0; position < values.length; position++) {
    const value = values[position];
    if (value === null) continue;
    if (peak === null || value.gt(peak)) {
      peak = value;
      continue;
    }
    const fall = peak.minus(value);
    if (fall.isPositive() && (largest === null || fall.gt(largest))) {
      largest = fall;
      trough = position;
    }
  }
  return trough;
}

const bucketOf = (x: number, buckets: number) => Math.max(0, Math.min(buckets - 1, Math.floor((x / 100) * buckets)));

/**
 * Min/max decimation of a drawn run (points in x order, in percent of the plot): per x-bucket the first and last point
 * (so the path stays continuous between buckets) and the lowest and highest point (so no swing is flattened), in
 * their original order. At most four points per bucket; a run with fewer points per bucket comes back unchanged.
 */
export function decimatePath<P extends { x: number; y: number }>(points: readonly P[], buckets = PATH_BUCKETS): P[] {
  const kept: P[] = [];
  let start = 0;
  while (start < points.length) {
    const bucket = bucketOf(points[start].x, buckets);
    let end = start;
    let low = start;
    let high = start;
    while (end + 1 < points.length && bucketOf(points[end + 1].x, buckets) === bucket) {
      end += 1;
      if (points[end].y < points[low].y) low = end;
      if (points[end].y > points[high].y) high = end;
    }
    for (const position of [...new Set([start, low, high, end])].sort((a, b) => a - b)) kept.push(points[position]);
    start = end + 1;
  }
  return kept;
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th";
  return `${value}${suffix}`;
}

/** "Every 67th of 19,901 points": what a thinned chart's marks and table list. */
export function everyNth(count: number): string {
  return `Every ${ordinal(markStride(count))} of ${count.toLocaleString("en-US")} points`;
}
