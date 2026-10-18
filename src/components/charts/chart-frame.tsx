"use client";

import { type ReactNode, useId, useState } from "react";
import { cx } from "../ui/cx";
import { EmptyState } from "../ui/empty-state";
import type { ChartEmptyCopy } from "./types";

export type ChartFrameProps = {
  title: string;
  question: string;
  sample?: ReactNode;
  /** Text alternative read by assistive technology (linked with aria-describedby). */
  summary: string;
  /** Table view of the same data; always present in the HTML, shown with the Table toggle. */
  table: ReactNode;
  legend?: ReactNode;
  actions?: ReactNode;
  /** When set, the empty state replaces the chart and the table. */
  empty?: ChartEmptyCopy;
  headingLevel?: 2 | 3;
  className?: string;
  children: ReactNode;
};

/** Figure wrapper shared by every chart: title, question, sample size, Chart/Table toggle, summary. */
export function ChartFrame({ title, question, sample, summary, table, legend, actions, empty, headingLevel = 3, className, children }: ChartFrameProps) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const id = useId();
  const titleId = `${id}-title`;
  const summaryId = `${id}-summary`;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <figure className={cx("chart-frame", className)} aria-labelledby={titleId} aria-describedby={summaryId}>
      <div className="chart-frame-header">
        <div className="min-w-0">
          <Heading id={titleId} className="chart-frame-title">
            {title}
          </Heading>
          <p className="chart-frame-question">{question}</p>
        </div>
        <div className="chart-frame-tools">
          {actions}
          {!empty && (
            // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a form fieldset.
            <div className="segmented segmented-sm" role="group" aria-label={`${title}: view`}>
              <button type="button" className="segmented-label" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
                Chart
              </button>
              <button type="button" className="segmented-label" aria-pressed={view === "table"} onClick={() => setView("table")}>
                Table
              </button>
            </div>
          )}
        </div>
      </div>
      {empty ? (
        <EmptyState compact title={empty.title} description={empty.description} actions={empty.actions} />
      ) : (
        <>
          <div className="chart-view" hidden={view !== "chart"}>
            {children}
            {legend}
          </div>
          <div className="chart-view" hidden={view !== "table"}>
            {table}
          </div>
        </>
      )}
      <figcaption className="chart-frame-sample">
        {sample}
        <span id={summaryId} className="sr-only">
          {summary}
        </span>
      </figcaption>
    </figure>
  );
}
