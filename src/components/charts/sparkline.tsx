import { cx } from "../ui/cx";
import { areaPath, type Dec, linePath, pointPositions, SVG_VIEWBOX, toDecimal, topPercent } from "./scale";
import { seriesClass } from "./tones";
import type { SeriesTone } from "./types";

export type SparklineProps = {
  /** Values in order (decimal strings). */
  values: string[];
  tone?: SeriesTone;
  /** Accessible description; without it the sparkline is decorative (its numbers must be shown nearby). */
  label?: string;
  area?: boolean;
  className?: string;
};

/** Tiny trend line for stat tiles (no axes, no interaction). */
export function Sparkline({ values, tone, label, area = true, className }: SparklineProps) {
  const decimals = values.map((value) => toDecimal(value)).filter((value): value is Dec => value !== null);
  const xs = pointPositions(decimals.length);
  const domain =
    decimals.length > 0
      ? { min: decimals.reduce((low, value) => (value.lt(low) ? value : low)), max: decimals.reduce((high, value) => (value.gt(high) ? value : high)) }
      : null;
  const points = domain ? decimals.map((value, index) => ({ x: xs[index], y: topPercent(value, domain) })) : [];
  const marks = (
    <>
      {area && points.length > 1 && <path className="sparkline-area" d={areaPath(points, 100)} />}
      {points.length > 1 && <path className="sparkline-line" d={linePath(points)} />}
    </>
  );
  const classes = cx("sparkline", tone && seriesClass(tone), className);
  if (!label) {
    return (
      <svg className={classes} viewBox={SVG_VIEWBOX} preserveAspectRatio="none" focusable="false" aria-hidden="true">
        {marks}
      </svg>
    );
  }
  return (
    <svg className={classes} viewBox={SVG_VIEWBOX} preserveAspectRatio="none" focusable="false" role="img" aria-label={label}>
      <title>{label}</title>
      {marks}
    </svg>
  );
}
