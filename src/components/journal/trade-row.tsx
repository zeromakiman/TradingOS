// biome-ignore-all lint/performance/noImgElement: owner-only evidence thumbnails are served privately (no-store) and must not enter the image optimizer cache.
import { ImageOff, Sparkles } from "lucide-react";
import Link from "next/link";
import { Badge, StatusPill } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import type { TradeRowView, ValueView } from "./types";

/**
 * One Journal row (docs/V2_ARCHITECTURE.md §14.5): the whole row links to the trade. One markup serves both layouts,
 * chosen by the width of the list (container query): below 60rem a compact card (instrument and result first), from
 * 60rem (a 1280px window with the sidebar open) a table-like row whose columns line up with `JOURNAL_COLUMNS`. Wrappers
 * switch between `display: contents` and a real box so each value exists once in the DOM; every cell is placed
 * explicitly, so the DOM keeps reading order (instrument first, thumbnail last).
 */

/**
 * Grid template shared by the rows and the column header. Table columns: thumbnail, trade, model, planned risk,
 * realized R, P&L, state (fits the longest pill, "Locked · waiting for entry", after a wider gap from the numbers),
 * tags, AI mark. Their minimums add up to the 60rem the table starts at; spare width goes to trade and tags first.
 */
export const JOURNAL_COLUMNS =
  "grid-cols-[4rem_minmax(0,1fr)_auto] @min-[60rem]:grid-cols-[4rem_minmax(10.75rem,2fr)_5.5rem_4.75rem_4.75rem_minmax(5.25rem,0.8fr)_10.75rem_minmax(4.75rem,1.4fr)_1.25rem]";

/** Tables narrower than 70rem (tags column under ~170px) show one tag chip; the count after it covers the rest. */
const WIDE_TAG = "@min-[60rem]:@max-[70rem]:hidden";
const NARROW_TABLE_TAG = "hidden @min-[60rem]:@max-[70rem]:inline";

const toneClass: Record<ValueView["tone"], string> = { pos: "value-pos", neg: "value-neg", neutral: "text-1", muted: "text-3" };

function Value({ value, label, className }: { value: ValueView; label: string; className?: string }) {
  return (
    <span className={cx("num", toneClass[value.tone], value.pending && "@max-[60rem]:hidden", className)}>
      <span className="sr-only">{label}: </span>
      {value.srText ? (
        <>
          <span aria-hidden="true">{value.text}</span>
          <span className="sr-only">{value.srText}</span>
        </>
      ) : (
        value.text
      )}
    </span>
  );
}

function Thumbnail({ row }: { row: TradeRowView }) {
  if (!row.thumbnail) {
    return (
      <span className="grid h-10 w-16 place-items-center rounded-control border border-dashed border-border-strong bg-surface-sunken text-3">
        <ImageOff aria-hidden="true" className="size-4" />
        <span className="sr-only">No screenshot</span>
      </span>
    );
  }
  return (
    <span className="relative block h-10 w-16 overflow-hidden rounded-control border border-border bg-surface-sunken">
      {/* Decorative preview: the row text carries the trade; the trade page has the full gallery. */}
      <img src={row.thumbnail.src} alt="" loading="lazy" decoding="async" width={64} height={40} className="size-full object-cover" />
      {/* A fixed dark scrim in both themes: it sits on the screenshot, not on a surface. */}
      {row.thumbnail.extra > 0 && (
        <span className="absolute right-0.5 bottom-0.5 rounded bg-[rgb(17_24_39/0.72)] px-1 text-[0.625rem] leading-4 font-semibold text-white num">
          +{row.thumbnail.extra}
        </span>
      )}
      <span className="sr-only">{row.evidenceCount === 1 ? "1 screenshot" : `${row.evidenceCount} screenshots`}</span>
    </span>
  );
}

/** Tag chips; screen readers get every tag in words instead of the chips and the "+n" summary. */
function Tags({ row }: { row: TradeRowView }) {
  const shown = row.tags.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1 @min-[60rem]:col-start-8 @min-[60rem]:row-start-1 @min-[60rem]:flex-nowrap @min-[60rem]:overflow-hidden">
      <span className="sr-only">Tags: {row.tagsText}</span>
      {row.tags.map((tag, index) => (
        <span
          key={tag}
          aria-hidden="true"
          className={cx("max-w-36 min-w-0 truncate rounded bg-surface-sunken px-1.5 text-xs leading-5 text-2", index > 0 && WIDE_TAG)}
        >
          {tag}
        </span>
      ))}
      {row.hiddenTagCount > 0 && (
        <span aria-hidden="true" className={cx("flex-none text-xs text-3", shown > 1 && WIDE_TAG)}>
          +{row.hiddenTagCount}
        </span>
      )}
      {shown > 1 && (
        <span aria-hidden="true" className={cx("flex-none text-xs text-3", NARROW_TABLE_TAG)}>
          +{shown - 1 + row.hiddenTagCount}
        </span>
      )}
    </span>
  );
}

export function TradeRow({ row }: { row: TradeRowView }) {
  const metaExtras = [row.model, row.plannedRisk.tone === "muted" ? null : `${row.plannedRisk.text} risk`].filter(Boolean).join(" · ");
  return (
    <Link
      href={row.href}
      className={cx(
        "grid items-center gap-x-3 gap-y-0.5 px-3 py-2.5 text-1 no-underline transition-colors hover:bg-surface-sunken focus-visible:-outline-offset-2 sm:px-4 @min-[60rem]:gap-y-0 @min-[60rem]:py-2",
        JOURNAL_COLUMNS,
      )}
    >
      {/* Instrument, direction, origin; then when and where. */}
      <span className="contents @min-[60rem]:col-start-2 @min-[60rem]:row-start-1 @min-[60rem]:flex @min-[60rem]:min-w-0 @min-[60rem]:flex-col @min-[60rem]:gap-0.5">
        <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">
            {row.symbol}
            {row.direction && <span className="font-normal text-2"> · {row.direction}</span>}
          </span>
          <Badge className="flex-none" title={row.origin.title ?? undefined}>
            {row.origin.label}
          </Badge>
        </span>
        <span className="col-start-2 row-start-2 min-w-0 truncate t-meta">
          <span className="num">{row.timeLabel}</span>
          {row.accountName && <span> · {row.accountName}</span>}
        </span>
      </span>

      <span className="hidden @min-[60rem]:col-start-3 @min-[60rem]:row-start-1 @min-[60rem]:block @min-[60rem]:truncate @min-[60rem]:text-sm @min-[60rem]:text-2">
        <span className="sr-only">Model: </span>
        {row.model ?? <span className="text-3">—</span>}
      </span>
      <Value value={row.plannedRisk} label="Planned risk" className="hidden text-sm @min-[60rem]:col-start-4 @min-[60rem]:row-start-1 @min-[60rem]:block @min-[60rem]:text-right" />

      <Value value={row.realizedR} label="Realized R" className="col-start-3 row-start-1 text-right text-sm font-semibold @min-[60rem]:col-start-5" />
      <Value value={row.pnl} label="P&L" className="col-start-3 row-start-2 text-right text-[0.8125rem] @min-[60rem]:col-start-6 @min-[60rem]:row-start-1 @min-[60rem]:text-sm" />

      {/* State, model, risk, tags and the AI mark: one wrapping line in the card, separate columns in the table. */}
      <span className="col-span-2 col-start-2 row-start-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-1 @min-[60rem]:contents">
        <span className="flex min-w-0 @min-[60rem]:col-start-7 @min-[60rem]:row-start-1 @min-[60rem]:pl-3">
          <StatusPill tone={row.state.tone}>{row.state.label}</StatusPill>
        </span>
        {metaExtras && <span className="t-meta @min-[60rem]:hidden">{metaExtras}</span>}
        {row.tags.length > 0 && <Tags row={row} />}
        {row.aiReviewed && (
          <span className="ml-auto flex text-accent @min-[60rem]:col-start-9 @min-[60rem]:row-start-1 @min-[60rem]:ml-0 @min-[60rem]:justify-end" title="AI-reviewed">
            <Sparkles aria-hidden="true" className="size-4" />
            <span className="sr-only">AI-reviewed</span>
          </span>
        )}
      </span>

      {/* Last in reading order (the row is read as instrument first); placed in the first column by the grid. */}
      <span className="col-start-1 row-span-3 row-start-1 self-start pt-0.5 @min-[60rem]:row-span-1 @min-[60rem]:self-center @min-[60rem]:pt-0">
        <Thumbnail row={row} />
      </span>
    </Link>
  );
}
