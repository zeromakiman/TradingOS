// biome-ignore-all lint/performance/noImgElement: owner-only evidence thumbnails are served privately (no-store) and must not enter the image optimizer cache.
"use client";

import { ImageOff, Images } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { useTimeFormat } from "@/components/shell/time-display";
import { useMediaQuery } from "@/components/shell/use-media-query";
import { StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Sheet, SheetContent } from "@/components/ui/dialog";
import { plural } from "@/domain/format";
import { toneClass } from "./format";
import type { CalendarDayModel, CalendarTrade } from "./model";

export type DaySheetProps = {
  /** The day shown; kept while the sheet closes. */
  day: CalendarDayModel | null;
  open: boolean;
  multiAccount: boolean;
  onClose: () => void;
  /** Where the focus goes when the sheet has closed (the sheet has no trigger of its own). */
  onCloseAutoFocus: (event: Event) => void;
};

/** "2 closed trades · -1.05R (1 of 2 with risk) · -$83.85": every figure of the day, R with its coverage. */
export function daySummary(day: CalendarDayModel): string {
  return [plural(day.closed, "closed trade"), day.rLabel ? day.rDetail : "no recorded risk", ...day.money.map(entry => entry.netLabel)].join(" · ");
}

/**
 * The trades closed on one calendar day (§14.6): each row opens its trade, and its screenshot opens the trade's
 * evidence viewer on the cover screenshot. Exit times follow the user's time display. A side sheet from tablet width,
 * a bottom sheet on phones; every target is at least 44px tall on touch screens (§13.5).
 */
export function DaySheet({ day, open, multiAccount, onClose, onCloseAutoFocus }: DaySheetProps) {
  const wide = useMediaQuery("(min-width: 48rem)", true);
  return (
    <Sheet open={open && day !== null} onOpenChange={next => !next && onClose()}>
      {day && (
        <SheetContent side={wide ? "right" : "bottom"} title={day.label} description={`${daySummary(day)} · exit day (UTC−5)`} onCloseAutoFocus={onCloseAutoFocus}>
          <ul className="-mx-2 flex flex-col divide-y divide-border" aria-label={`Trades closed on ${day.label}`}>
            {day.trades.map(trade => (
              <DayTrade key={trade.id} trade={trade} multiAccount={multiAccount} />
            ))}
          </ul>
          {day.journalHref && (
            <Link href={day.journalHref} prefetch={false} className={buttonClasses({ variant: "secondary", className: "mt-4 w-full" })}>
              Open these trades in the Journal
            </Link>
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}

/** One trade of the day: its screenshot (opens the evidence viewer) and the row (opens the trade). */
export function DayTrade({ trade, multiAccount }: { trade: CalendarTrade; multiAccount: boolean }) {
  const format = useTimeFormat();
  const meta = [
    { key: "account", text: multiAccount ? trade.account : null },
    { key: "model", text: trade.model },
    { key: "origin", text: trade.origin },
  ].filter((part): part is { key: string; text: string } => Boolean(part.text));
  const screenshots = trade.evidenceHref && trade.evidenceCount > 0 ? trade.evidenceHref : null;
  return (
    <li className="flex items-start gap-1 py-1.5">
      {/* The screenshot opens the evidence viewer (its own 56px target); the rest of the row opens the trade. */}
      {screenshots && trade.thumbSrc ? (
        <Link
          href={screenshots}
          prefetch={false}
          className="relative mt-1 ml-2 shrink-0 rounded-control"
          aria-label={`${plural(trade.evidenceCount, "screenshot")} of ${trade.title}`}
        >
          <img src={trade.thumbSrc} alt="" loading="lazy" decoding="async" className="h-14 w-20 rounded-control border border-border bg-surface-sunken object-cover" />
          <span className="absolute right-1 bottom-1 inline-flex items-center gap-0.5 rounded-full bg-surface/90 px-1.5 text-[0.6875rem] leading-4 font-semibold text-text num" aria-hidden="true">
            <Images className="size-3" />
            {trade.evidenceCount}
          </span>
        </Link>
      ) : (
        <span className="mt-1 ml-2 flex h-14 w-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded-control border border-dashed border-border-strong text-3" aria-hidden="true">
          <ImageOff className="size-4" />
          <span className="text-[0.6875rem] leading-4">No screenshots</span>
        </span>
      )}
      <Link href={trade.href} prefetch={false} className="group flex min-h-11 min-w-0 flex-1 flex-col gap-1 rounded-control px-2 py-1 hover:bg-surface-sunken">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate font-semibold group-hover:underline">{trade.title}</span>
          <span className={cx("shrink-0 font-semibold num", toneClass(trade.rTone))}>{trade.rLabel}</span>
        </span>
        <span className="flex items-baseline justify-between gap-3 t-meta">
          <span className="min-w-0" title={trade.originNote ?? undefined}>
            {/* Wraps between the parts only ("Live-first" never splits at its hyphen). */}
            {meta.map((part, index) => (
              <Fragment key={part.key}>
                {index > 0 && " · "}
                <span className="whitespace-nowrap">{part.text}</span>
              </Fragment>
            ))}
          </span>
          <span className={cx("shrink-0 num", toneClass(trade.pnlTone))}>{trade.pnlLabel}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="t-caption num">
            Closed {format.time(trade.exitedAt)} {format.zone(trade.exitedAt)}
          </span>
          <StatusPill tone={trade.state.tone}>{trade.state.label}</StatusPill>
        </span>
      </Link>
    </li>
  );
}
