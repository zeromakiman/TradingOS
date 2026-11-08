import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { ChartTip } from "./types";

/** Accessible name of a mark: the same words the tooltip shows. */
export function tipLabel(tip: ChartTip) {
  const rows = tip.rows.map((row) => (row.label ? `${row.label} ${row.value}` : row.value)).join(", ");
  return [`${tip.title}: ${rows}`, tip.note].filter(Boolean).join(". ");
}

export type ChartMarkProps = {
  index: number;
  tip: ChartTip;
  /** Drill-down target; marks without one are buttons that reveal their readout. */
  href?: string;
  /** Only one mark per chart is in the tab order; arrow keys move between the rest. */
  focusable: boolean;
  className?: string;
  style?: CSSProperties;
  /** Extra `data-*` attributes for styling (tone, level). */
  data?: Record<`data-${string}`, string | number | undefined>;
  children?: ReactNode;
};

/** Hover, focus and click target for one data mark (bigger than the painted mark). */
export function ChartMark({ index, tip, href, focusable, className = "chart-hit", style, data, children }: ChartMarkProps) {
  const shared = { ...data, "data-mark": index, "aria-label": tipLabel(tip), tabIndex: focusable ? 0 : -1, className, style };
  if (href) {
    return (
      <Link href={href} prefetch={false} {...shared}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" {...shared}>
      {children}
    </button>
  );
}
