import type { CSSProperties } from "react";
import Decimal from "decimal.js";

/**
 * Chart geometry. Values arrive as canonical decimal strings and stay Decimal for every
 * comparison, extent and tick; the only conversion to JavaScript numbers is the final
 * percentage used to position a mark, which is a pixel concern and never feeds a verdict.
 * Every function returns finite numbers for empty, single-value and flat data.
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export function toDecimal(value: string | null | undefined): Dec | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  try {
    const parsed = new D(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

export const ZERO = new D(0);

export type NiceScale = {
  min: Dec;
  max: Dec;
  step: Dec;
  ticks: Dec[];
};

export type ScaleOptions = {
  /** Keep zero inside the domain (baselines, signed values). Default true. */
  includeZero?: boolean;
  /** Integer ticks only (counts). */
  integer?: boolean;
  /** Approximate number of ticks. */
  tickCount?: number;
  /** Domain used when every value is zero or there are no values. */
  flat?: { min: string; max: string };
  /**
   * Room for direct labels beyond the data, as a fraction of the data span: added above a
   * positive maximum and below a negative minimum (on both sides when zero is not included).
   */
  headroom?: number;
};

/** Headroom that keeps a direct label (about 22px) inside plots of 13rem and taller. */
export const LABEL_HEADROOM = 0.15;

/** A direct label fits above or below a mark when the mark is at least this far (percent) from the plot edge. */
export const LABEL_ROOM = 11;

const MAX_TICKS = 9;

/** Smallest "nice" step (1, 2, 2.5 or 5 × 10ⁿ) that covers `span` in `intervals` steps. */
function niceStep(span: Dec, intervals: number, integer: boolean): Dec {
  const raw = span.div(intervals);
  const magnitude = new D(10).pow(raw.log(10).floor());
  const factors = integer && magnitude.lt(10) ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  for (const factor of factors) {
    const step = magnitude.mul(factor);
    if (raw.lte(step)) return integer ? D.max(step, 1) : step;
  }
  return magnitude.mul(10);
}

function ticksBetween(min: Dec, max: Dec, step: Dec): Dec[] {
  const ticks: Dec[] = [];
  for (let tick = min; tick.lte(max); tick = tick.plus(step)) ticks.push(tick);
  return ticks;
}

/** A rounded domain with evenly spaced ticks that contains every value. */
export function niceScale(values: Dec[], { includeZero = true, integer = false, tickCount = 5, flat, headroom = 0 }: ScaleOptions = {}): NiceScale {
  let low = values.length > 0 ? D.min(...values) : ZERO;
  let high = values.length > 0 ? D.max(...values) : ZERO;
  if (includeZero) {
    low = D.min(low, ZERO);
    high = D.max(high, ZERO);
  }
  if (headroom > 0 && low.lt(high)) {
    const pad = high.minus(low).mul(headroom);
    if (!includeZero || high.gt(0)) high = high.plus(pad);
    if (!includeZero || low.lt(0)) low = low.minus(pad);
  }
  if (low.eq(high)) {
    if (low.isZero()) {
      low = new D(flat?.min ?? (integer ? "0" : "-1"));
      high = new D(flat?.max ?? "1");
    } else {
      const pad = low.abs().mul("0.05");
      low = low.minus(pad);
      high = high.plus(pad);
    }
  }

  let step = niceStep(high.minus(low), Math.max(1, tickCount - 1), integer);
  let min = low.div(step).floor().mul(step);
  let max = high.div(step).ceil().mul(step);
  let ticks = ticksBetween(min, max, step);
  while (ticks.length > MAX_TICKS) {
    step = step.mul(2);
    min = low.div(step).floor().mul(step);
    max = high.div(step).ceil().mul(step);
    ticks = ticksBetween(min, max, step);
  }
  return { min, max, step, ticks };
}

/** Position of `value` within the domain as 0…1 (clamped). */
export function ratio(value: Dec, domain: { min: Dec; max: Dec }): number {
  const span = domain.max.minus(domain.min);
  if (span.isZero()) return 0.5;
  const position = value.minus(domain.min).div(span).toNumber();
  if (!Number.isFinite(position)) return 0.5;
  return Math.min(1, Math.max(0, position));
}

/** Distance from the top of the plot, in percent, for a value on a vertical axis. */
export function topPercent(value: Dec, domain: { min: Dec; max: Dec }): number {
  return round((1 - ratio(value, domain)) * 100);
}

/** Distance from the left of the plot, in percent, for a value on a horizontal axis. */
export function leftPercent(value: Dec, domain: { min: Dec; max: Dec }): number {
  return round(ratio(value, domain) * 100);
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** x positions (percent) of `count` evenly spaced points; a single point sits in the middle. */
export function pointPositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [50];
  return Array.from({ length: count }, (_, index) => round((index / (count - 1)) * 100));
}

/** Equal bands for `count` categories: band width and band centres (percent). */
export function bandLayout(count: number): { band: number; centers: number[] } {
  if (count <= 0) return { band: 100, centers: [] };
  const band = 100 / count;
  return { band: round(band), centers: Array.from({ length: count }, (_, index) => round((index + 0.5) * band)) };
}

/** Hover/focus strips around point positions: each point owns the space up to the midpoints with its neighbours. */
export function pointHitAreas(positions: number[]): { left: number; width: number }[] {
  return positions.map((x, index) => {
    const left = index === 0 ? 0 : (positions[index - 1] + x) / 2;
    const right = index === positions.length - 1 ? 100 : (x + positions[index + 1]) / 2;
    return { left: round(left), width: round(Math.max(0, right - left)) };
  });
}

export type AxisLabelSlot = { index: number; minor: boolean };

/**
 * Which category labels to print on an x axis: at most `max` evenly spaced labels that
 * always include the first and last; on narrow screens only first and last are shown.
 */
export function axisLabelSlots(count: number, max = 6): AxisLabelSlot[] {
  if (count <= 0) return [];
  if (count === 1) return [{ index: 0, minor: false }];
  const stride = Math.max(1, Math.ceil((count - 1) / Math.max(1, max - 1)));
  const slots: AxisLabelSlot[] = [];
  for (let index = 0; index < count - 1; index += stride) slots.push({ index, minor: index !== 0 });
  const last = count - 1;
  const previous = slots.at(-1);
  if (previous && previous.index !== 0 && last - previous.index < stride) slots.pop();
  slots.push({ index: last, minor: false });
  return slots;
}

const VIEWBOX = 1000;
const toView = (percent: number) => (round(percent * (VIEWBOX / 100), 2)).toFixed(2);

/** SVG path through points given in percent; empty for fewer than two points. */
export function linePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${toView(point.x)} ${toView(point.y)}`).join(" ");
}

/** Closed area between the line and a horizontal baseline (percent from the top). */
export function areaPath(points: { x: number; y: number }[], baseline: number): string {
  if (points.length < 2) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `M${toView(first.x)} ${toView(baseline)} ${points.map((point) => `L${toView(point.x)} ${toView(point.y)}`).join(" ")} L${toView(last.x)} ${toView(baseline)} Z`;
}

export const SVG_VIEWBOX = `0 0 ${VIEWBOX} ${VIEWBOX}`;

/** Horizontal alignment of a direct label so it never runs past the plot edge. */
export function labelAlign(x: number): "start" | "end" | undefined {
  if (x >= 85) return "end";
  if (x <= 15) return "start";
  return undefined;
}

/** Sign of a decimal value as a mark category. */
export function signOf(value: Dec): "pos" | "neg" | "zero" {
  if (value.isZero()) return "zero";
  return value.isNegative() ? "neg" : "pos";
}

/** Index of the largest and smallest value (first occurrence), compared exactly. */
export function extremes(values: (Dec | null)[]): { maxIndex: number; minIndex: number } | null {
  let maxIndex = -1;
  let minIndex = -1;
  values.forEach((value, index) => {
    if (value === null) return;
    const max = maxIndex >= 0 ? values[maxIndex] : null;
    const min = minIndex >= 0 ? values[minIndex] : null;
    if (max === null || value.gt(max)) maxIndex = index;
    if (min === null || value.lt(min)) minIndex = index;
  });
  return maxIndex < 0 ? null : { maxIndex, minIndex };
}

/**
 * Intensity step 1…4 for a heatmap cell: the smallest k with |value| × 4 ≤ max × k
 * (cross-multiplied, so no quotient is compared). Zero and empty values are step 0.
 */
export function intensityLevel(value: Dec, maxAbs: Dec): 0 | 1 | 2 | 3 | 4 {
  if (value.isZero() || maxAbs.isZero()) return 0;
  const scaled = value.abs().mul(4);
  for (const level of [1, 2, 3] as const) if (scaled.lte(maxAbs.mul(level))) return level;
  return 4;
}

/** Inline style that sets CSS custom properties (for example the bar band width). */
export function cssVars(variables: Record<`--${string}`, string>): CSSProperties {
  return variables as CSSProperties;
}
