import { Fragment } from "react";
import { cx } from "../ui/cx";
import { CategoryTable } from "./category-table";
import { ChartFrame } from "./chart-frame";
import { ChartInteraction } from "./interaction";
import { ChartMark } from "./marks";
import { type Dec, leftPercent, round, signOf, toDecimal, ZERO } from "./scale";
import { categorySummary } from "./summary";
import { seriesClass } from "./tones";
import type { ChartDatum, ChartEmptyCopy, ChartFigureProps, ChartTip, SeriesTone } from "./types";

const DEFAULT_EMPTY: ChartEmptyCopy = {
  title: "Nothing to compare yet.",
  description: "Groups appear here once trades are closed.",
};

/**
 * Narrow containers (phones, narrow cards) stack each row: name, sample and value on one line, the bar across the full
 * width below. Side by side, a mixed positive/negative chart reserves room for value labels on both sides of its
 * track, which left the bars almost no width in a phone-sized card. The list is the size container (32rem threshold).
 */
const STACKED_ROW = "@max-[32rem]:grid-cols-[minmax(0,1fr)_auto] @max-[32rem]:gap-x-3 @max-[32rem]:gap-y-1 @max-[32rem]:py-2";
/** The row's value, beside the name when stacked (the bar's tip label is hidden then). */
const STACKED_VALUE = "hidden self-start text-xs font-semibold tabular-nums text-text @max-[32rem]:block";
const STACKED_TRACK = "@max-[32rem]:col-span-2 @max-[32rem]:mx-0";
const TIP_VALUE = "@max-[32rem]:hidden";

/**
 * A group's sample line ("N = 27 · 1 without risk · Emerging tendency") is never cut off at any width: it names the
 * group's N and its evidence label (§13.8). It wraps only between its " · " parts, so "N = 27" or "Insufficient
 * evidence" stays whole, and a part wider than the label column wraps inside itself instead of being clipped. The
 * text is unchanged (each separator stays at the end of the part before it).
 */
function Detail({ text }: { text: string }) {
  const parts = text.split(" · ");
  return (
    <span className="hbar-detail whitespace-normal">
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string; a part may repeat.
        <Fragment key={index}>
          {index > 0 && " "}
          <span className="inline-block wrap-anywhere">{index < parts.length - 1 ? `${part} ·` : part}</span>
        </Fragment>
      ))}
    </span>
  );
}

export type HBarChartProps = ChartFigureProps & {
  /** One row per group: label = group, detail = sample ("N = 12 · early sample"). */
  data: ChartDatum[];
  /** `signed` colours bars by profit/loss; a series tone colours every bar the same. */
  tone?: "signed" | SeriesTone;
  categoryLabel?: string;
  valueName?: string;
};

/** Breakdown and contribution bars ("Which conditions perform?", "Which account contributes most?"). */
export function HBarChart({
  title,
  question,
  sample,
  summary,
  empty,
  actions,
  headingLevel,
  className,
  data,
  tone = "signed",
  categoryLabel = "Group",
  valueName = "Value",
}: HBarChartProps) {
  const resolvedSummary = summary ?? categorySummary(title, data);
  if (data.length === 0) {
    return (
      <ChartFrame title={title} question={question} sample={sample} summary={resolvedSummary} table={null} empty={empty ?? DEFAULT_EMPTY} actions={actions} headingLevel={headingLevel} className={className}>
        {null}
      </ChartFrame>
    );
  }

  const values = data.map((datum) => toDecimal(datum.value));
  const known = values.filter((value): value is Dec => value !== null);
  const low = known.reduce((min, value) => (value.lt(min) ? value : min), ZERO);
  const high = known.reduce((max, value) => (value.gt(max) ? value : max), ZERO);
  const domain = low.eq(high) ? { min: ZERO, max: ZERO.plus(1) } : { min: low, max: high };
  const zero = leftPercent(ZERO, domain);
  const hasNegative = low.lt(0);
  const hasPositive = high.gt(0);
  // Side by side, value labels sit beyond the bar tips; the track leaves them 4.5rem on each side that has bars.
  const trackRoom = cx(hasNegative && "ml-18", hasPositive && "mr-18", STACKED_TRACK);
  const tips: ChartTip[] = data.map((datum) => ({ title: datum.label, rows: [{ value: datum.valueLabel, label: valueName }], note: datum.detail }));

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
      <ChartInteraction tips={tips}>
        <ul aria-label={`${title}: rows. Use the arrow keys to move between them.`} className="hbar-list @container">
          {data.map((datum, index) => {
            const value = values[index];
            const end = value === null ? zero : leftPercent(value, domain);
            const sign = value === null ? "zero" : signOf(value);
            const barSign = tone === "signed" ? sign : sign === "zero" ? "zero" : "neutral";
            return (
              <li key={datum.key}>
                <ChartMark index={index} tip={tips[index]} href={datum.href} focusable={index === 0} className={cx("hbar-row", STACKED_ROW)}>
                  <span className="hbar-label">
                    <span className="hbar-name">{datum.label}</span>
                    {datum.detail && <Detail text={datum.detail} />}
                  </span>
                  <span className={STACKED_VALUE} aria-hidden="true">
                    {datum.valueLabel}
                  </span>
                  <span className={cx("hbar-track", trackRoom)} aria-hidden="true">
                    <span className="hbar-zero" style={{ left: `${zero}%` }} />
                    {value !== null && (
                      <span
                        className={cx("hbar-bar", tone !== "signed" && seriesClass(tone))}
                        data-sign={barSign}
                        style={{ left: `${round(Math.min(zero, end))}%`, width: `${round(Math.abs(end - zero))}%` }}
                      />
                    )}
                    <span className={cx("hbar-value", TIP_VALUE)} data-side={sign === "neg" ? "left" : "right"} style={{ left: `${end}%` }}>
                      {datum.valueLabel}
                    </span>
                  </span>
                </ChartMark>
              </li>
            );
          })}
        </ul>
      </ChartInteraction>
    </ChartFrame>
  );
}
