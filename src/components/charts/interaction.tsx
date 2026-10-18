"use client";

import { type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cx } from "../ui/cx";
import { nextMarkIndex } from "./keyboard";
import { seriesClass } from "./tones";
import type { ChartAnchor, ChartTip } from "./types";

/** Active mark: position in percent of this element; `bottom` is used when the readout flips below. */
type Active = { index: number; x: number; y: number; bottom: number };

export type ChartInteractionProps = {
  /** One readout per mark, indexed by the mark's `data-mark` attribute. */
  tips: ChartTip[];
  /** Tooltip anchor per mark in percent of this element; measured from the mark when omitted. */
  anchors?: ChartAnchor[];
  /** Line/area charts: vertical crosshair plus a dot per series at the active x. */
  crosshair?: boolean;
  /** Grid navigation step for ArrowUp/ArrowDown (7 for a calendar); defaults to 1. */
  columns?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

const markOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-mark]") : null);

/**
 * Client tooltip layer over server-rendered marks. Marks are links (drill-down) or buttons
 * carrying `data-mark`; hover and focus show the same readout, arrow keys move a roving
 * tabindex between marks, and Escape hides the readout. Values stay reachable without it
 * through each mark's accessible name and the chart's table view.
 */
export function ChartInteraction({ tips, anchors, crosshair = false, columns = 1, className, style, children }: ChartInteractionProps) {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Active | null>(null);

  const show = (mark: HTMLElement) => {
    const index = Number.parseInt(mark.dataset.mark ?? "", 10);
    if (!Number.isInteger(index) || !tips[index]) return;
    const anchor = anchors?.[index];
    if (anchor) {
      setActive({ index, x: anchor.x, y: anchor.y, bottom: anchor.y });
      return;
    }
    const box = root.current?.getBoundingClientRect();
    const rect = mark.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    setActive({
      index,
      x: ((rect.left + rect.width / 2 - box.left) / box.width) * 100,
      y: ((rect.top - box.top) / box.height) * 100,
      bottom: ((rect.bottom - box.top) / box.height) * 100,
    });
  };

  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const mark = markOf(event.target);
    if (mark) show(mark);
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const mark = markOf(event.target);
    if (mark) show(mark);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))) setActive(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mark = markOf(event.target);
    if (!mark || !root.current) return;
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    const marks = Array.from(root.current.querySelectorAll<HTMLElement>("[data-mark]"));
    const next = nextMarkIndex(event.key, marks.indexOf(mark), marks.length, columns);
    if (next === null) return;
    event.preventDefault();
    const target = marks[next];
    for (const candidate of marks) candidate.tabIndex = candidate === target ? 0 : -1;
    target.focus();
  };

  const tip = active ? tips[active.index] : undefined;
  const dots = active && crosshair ? (anchors?.[active.index]?.dots ?? []) : [];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: events are delegated from the focusable marks inside.
    <div
      ref={root}
      className={cx("chart-interaction", className)}
      style={style}
      onPointerOver={handlePointerOver}
      onPointerLeave={() => setActive(null)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {children}
      {active && crosshair && <div className="chart-crosshair" style={{ left: `${active.x}%` }} aria-hidden="true" />}
      {dots.map((dot) => (
        <span key={dot.tone} className={cx("chart-dot", seriesClass(dot.tone))} style={{ left: `${active?.x ?? 0}%`, top: `${dot.y}%` }} aria-hidden="true" />
      ))}
      {active && tip && <TooltipBox tip={tip} active={active} />}
    </div>
  );
}

function TooltipBox({ tip, active }: { tip: ChartTip; active: Active }) {
  const align = active.x < 18 ? "start" : active.x > 82 ? "end" : undefined;
  // Near the top there is no room above the mark, so the readout opens below it.
  const flip = active.y < 30;
  return (
    <div className="chart-tooltip" aria-hidden="true" data-align={align} data-flip={flip || undefined} style={{ left: `${active.x}%`, top: `${flip ? active.bottom : active.y}%` }}>
      <p className="chart-tooltip-title">{tip.title}</p>
      {tip.rows.map((row) => (
        <div key={`${row.tone ?? ""}|${row.label ?? ""}|${row.value}`} className="chart-tooltip-row">
          {row.tone && <span className={cx("chart-tooltip-key", seriesClass(row.tone))} />}
          <span className="chart-tooltip-value">{row.value}</span>
          {row.label && <span className="chart-tooltip-label">{row.label}</span>}
        </div>
      ))}
      {tip.note && <p className="chart-tooltip-label">{tip.note}</p>}
    </div>
  );
}
