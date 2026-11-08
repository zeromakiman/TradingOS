import type { CSSProperties } from "react";
import { cx } from "../ui/cx";
import { cssVars, type Dec, type NiceScale, round, topPercent } from "./scale";
import type { TickFormatter } from "./types";

export type YTick = { key: string; value: Dec; text: string };

/** Y-axis labels. The scale's step lets a formatter print exactly the precision that keeps neighbouring labels distinct. */
export function yTicks(scale: NiceScale, format: TickFormatter): YTick[] {
  const step = scale.step.toFixed();
  return scale.ticks.map((tick) => ({ key: tick.toFixed(), value: tick, text: format(tick.toFixed(), step) }));
}

const DEFAULT_GUTTER_REM = 3.25;

/**
 * Widens the label gutter (default 3.25rem, set on `.chart`) for long labels such as full money
 * amounts. Width is estimated from the 12px tabular figures: about 0.42rem per character plus
 * the gap to the plot.
 */
export function gutterStyle(ticks: YTick[]): CSSProperties | undefined {
  const longest = Math.max(0, ...ticks.map((tick) => tick.text.length));
  const needed = round(longest * 0.42 + 0.75, 2);
  return needed > DEFAULT_GUTTER_REM ? cssVars({ "--chart-gutter": `${needed}rem` }) : undefined;
}

/** Value labels of the single y axis, printed in the gutter beside the plot. */
export function YAxis({ scale, ticks }: { scale: NiceScale; ticks: YTick[] }) {
  return (
    <div className="chart-y-axis" aria-hidden="true">
      {ticks.map((tick) => (
        <span key={tick.key} className="chart-y-tick" style={{ top: `${topPercent(tick.value, scale)}%` }}>
          {tick.text}
        </span>
      ))}
    </div>
  );
}

/** Hairline gridlines at each tick; the zero line uses the stronger axis colour. */
export function Gridlines({ scale }: { scale: NiceScale }) {
  return (
    <>
      {scale.ticks.map((tick) => (
        <span key={tick.toFixed()} aria-hidden="true" className={tick.isZero() ? "chart-baseline" : "chart-gridline"} style={{ top: `${topPercent(tick, scale)}%` }} />
      ))}
    </>
  );
}

export type XAxisLabel = { key: string; text: string; x: number; minor?: boolean };

type LabelAlign = "start" | "center" | "end";

/** How XAxis anchors a label: edge labels are aligned inwards so they never overflow the plot. */
export function xLabelAlign(x: number): LabelAlign {
  if (x <= 8) return "start";
  if (x >= 92) return "end";
  return "center";
}

/** Estimated width of an axis label: 12px tabular figures are about 0.42rem per character (as the y gutter assumes). */
const CHAR_REM = 0.42;
/** Clear space kept between neighbouring labels. */
const LABEL_GAP_REM = 0.75;

/**
 * Narrowest plot (rem) in which these labels, anchored as XAxis anchors them, keep a gap between neighbours. An edge
 * label reaches inwards by its whole width (the last label ends at the plot's right edge), a centred one by half.
 */
export function xLabelsMinWidth(labels: readonly Pick<XAxisLabel, "text" | "x">[]): number {
  const sorted = [...labels].sort((a, b) => a.x - b.x);
  let needed = 0;
  for (let index = 1; index < sorted.length; index++) {
    const left = sorted[index - 1];
    const right = sorted[index];
    const leftWidth = left.text.length * CHAR_REM;
    const rightWidth = right.text.length * CHAR_REM;
    const reachRight = { start: leftWidth, center: leftWidth / 2, end: 0 }[xLabelAlign(left.x)];
    const reachLeft = { start: 0, center: rightWidth / 2, end: rightWidth }[xLabelAlign(right.x)];
    const span = (right.x - left.x) / 100;
    needed = Math.max(needed, span > 0 ? (reachRight + reachLeft + LABEL_GAP_REM) / span : Number.POSITIVE_INFINITY);
  }
  return round(needed, 2);
}

/**
 * Container widths (rem) below which the in-between labels hide. The classes are spelled out so Tailwind generates
 * them; each hides `[data-minor]` labels while the axis (a size container) is narrower than its width.
 */
const HIDE_MINOR_BELOW: readonly (readonly [number, string])[] = [
  [16, "@max-[16rem]:[&>[data-minor]]:hidden"],
  [20, "@max-[20rem]:[&>[data-minor]]:hidden"],
  [24, "@max-[24rem]:[&>[data-minor]]:hidden"],
  [28, "@max-[28rem]:[&>[data-minor]]:hidden"],
  [32, "@max-[32rem]:[&>[data-minor]]:hidden"],
  [36, "@max-[36rem]:[&>[data-minor]]:hidden"],
  [42, "@max-[42rem]:[&>[data-minor]]:hidden"],
  [48, "@max-[48rem]:[&>[data-minor]]:hidden"],
  [56, "@max-[56rem]:[&>[data-minor]]:hidden"],
  [64, "@max-[64rem]:[&>[data-minor]]:hidden"],
];

/**
 * Class that hides the in-between (minor) labels of an axis narrower than they need, so neighbouring labels never
 * overlap (the first and last stay); empty when every width fits them.
 */
export function minorLabelsClass(labels: readonly XAxisLabel[]): string {
  if (!labels.some((label) => label.minor)) return "";
  const needed = xLabelsMinWidth(labels);
  if (needed <= 0) return "";
  return HIDE_MINOR_BELOW.find(([width]) => width >= needed)?.[1] ?? "[&>[data-minor]]:hidden";
}

/**
 * Category labels under the plot; labels at the edges are aligned inwards so they never overflow. The axis is a size
 * container: the in-between labels hide where the plot is too narrow for them (narrow cards on wide screens too), and
 * below 768px viewports only the first and last are shown.
 */
export function XAxis({ labels }: { labels: XAxisLabel[] }) {
  return (
    <div className="chart-x-axis @container" aria-hidden="true">
      <div className={cx("absolute inset-0", minorLabelsClass(labels))}>
        {labels.map((label) => {
          const align = xLabelAlign(label.x);
          return (
            <span
              key={label.key}
              className="chart-x-tick"
              data-edge={align === "center" ? undefined : align}
              data-minor={label.minor || undefined}
              style={{ left: `${label.x}%` }}
            >
              {label.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
