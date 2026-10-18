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
        <ul aria-label={`${title}: rows. Use the arrow keys to move between them.`} className="hbar-list">
          {data.map((datum, index) => {
            const value = values[index];
            const end = value === null ? zero : leftPercent(value, domain);
            const sign = value === null ? "zero" : signOf(value);
            const barSign = tone === "signed" ? sign : sign === "zero" ? "zero" : "neutral";
            return (
              <li key={datum.key}>
                <ChartMark index={index} tip={tips[index]} href={datum.href} focusable={index === 0} className="hbar-row">
                  <span className="hbar-label">
                    <span className="hbar-name">{datum.label}</span>
                    {datum.detail && <span className="hbar-detail">{datum.detail}</span>}
                  </span>
                  <span className="hbar-track" aria-hidden="true" style={{ marginLeft: hasNegative ? "4.5rem" : 0, marginRight: hasPositive ? "4.5rem" : 0 }}>
                    <span className="hbar-zero" style={{ left: `${zero}%` }} />
                    {value !== null && (
                      <span
                        className={cx("hbar-bar", tone !== "signed" && seriesClass(tone))}
                        data-sign={barSign}
                        style={{ left: `${round(Math.min(zero, end))}%`, width: `${round(Math.abs(end - zero))}%` }}
                      />
                    )}
                    <span className="hbar-value" data-side={sign === "neg" ? "left" : "right"} style={{ left: `${end}%` }}>
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
