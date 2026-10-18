import type { CSSProperties } from "react";
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

/** Category labels under the plot; labels at the edges are aligned inwards so they never overflow. */
export function XAxis({ labels }: { labels: XAxisLabel[] }) {
  return (
    <div className="chart-x-axis" aria-hidden="true">
      {labels.map((label) => (
        <span
          key={label.key}
          className="chart-x-tick"
          data-edge={label.x <= 8 ? "start" : label.x >= 92 ? "end" : undefined}
          data-minor={label.minor || undefined}
          style={{ left: `${label.x}%` }}
        >
          {label.text}
        </span>
      ))}
    </div>
  );
}
