import {
  ArrowRightLeft, BookOpen, CalendarDays, ChartCandlestick, ChartColumn, Clock, FileText, Image as ImageIcon, Link2, type LucideIcon, NotebookPen,
  Quote, Scale, ShieldCheck, Sigma, Tag,
} from "lucide-react";
import Link from "next/link";
import type { SourceChipKind } from "@/domain/ai-summary";
import { cx } from "../ui/cx";
import { chipLabel, type SourceChipModel, safeChipHref, withKeys } from "./model";

export type { SourceChipModel } from "./model";

/**
 * Friendly citation chip (docs/V2_ARCHITECTURE.md §11.1): "Trade plan", "M5 chart", "Live note · 09:45",
 * "EURUSD long · Oct 14". Screenshots link to `#evidence-<id>` (the evidence gallery opens its viewer), trades to
 * `/trades/<id>`, timeline records to `#<TimelineItem.id>`. The raw citation id never appears in the chip's text;
 * Technical details list it.
 */

const KIND_ICONS: Readonly<Record<SourceChipKind, LucideIcon>> = {
  plan: FileText,
  thesis: Quote,
  strategy: BookOpen,
  "risk-engine": ShieldCheck,
  "risk-plan": Scale,
  execution: ArrowRightLeft,
  tags: Tag,
  evidence: ImageIcon,
  note: NotebookPen,
  event: Clock,
  trade: ChartCandlestick,
  period: CalendarDays,
  sample: Sigma,
  metrics: ChartColumn,
  unknown: Link2,
};

/** Extra words for screen readers on chips that navigate. */
const LINK_HINTS: Partial<Record<SourceChipKind, string>> = {
  evidence: "open screenshot",
  note: "show in timeline",
  event: "show in timeline",
  trade: "open trade",
};

const CHIP =
  "relative inline-flex min-h-7 max-w-full items-center gap-1 rounded-pill border border-border bg-surface-sunken px-2 text-xs font-medium text-2 [&_svg]:size-3.5 [&_svg]:flex-none";
/** Links keep a 40px hit area without growing visually (§13.5). */
const LINK = "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:border-border-strong hover:text-text";

export function SourceChip({ chip }: { chip: SourceChipModel }) {
  const Icon = Object.hasOwn(KIND_ICONS, chip.kind) ? KIND_ICONS[chip.kind] : Link2;
  const label = chipLabel(chip.label);
  const href = safeChipHref(chip.href);
  const hint = LINK_HINTS[chip.kind];
  const content = (
    <>
      <Icon aria-hidden="true" />
      <span className="truncate">{label}</span>
      {href && hint && <span className="sr-only"> · {hint}</span>}
    </>
  );
  if (!href) {
    return (
      <span className={CHIP} data-kind={chip.kind}>
        {content}
      </span>
    );
  }
  if (href.startsWith("#")) {
    return (
      <a href={href} className={cx(CHIP, LINK)} data-kind={chip.kind}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={cx(CHIP, LINK)} data-kind={chip.kind}>
      {content}
    </Link>
  );
}

/** A row of citation chips; renders nothing without sources. */
export function SourceChipList({ sources, className, label = "Sources" }: { sources: readonly SourceChipModel[]; className?: string; label?: string }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label={label} className={cx("flex flex-wrap items-center gap-1.5", className)}>
      {withKeys(sources, chip => chip.technicalId ?? `${chip.kind}:${chip.label}`).map(({ key, value }) => (
        <li key={key} className="max-w-full">
          <SourceChip chip={value} />
        </li>
      ))}
    </ul>
  );
}
