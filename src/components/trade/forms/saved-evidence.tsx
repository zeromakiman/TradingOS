// biome-ignore-all lint/performance/noImgElement: owner-only evidence thumbnails are served privately (no-store) and must not enter the image optimizer cache.
import { ArrowRight, Images } from "lucide-react";
import Link from "next/link";
import { evidenceTileId } from "@/components/evidence/gallery-model";
import { displayDay, formatDateTime, formatTime, type TimeDisplay } from "@/domain/time-display";
import type { ExistingEvidence } from "./types";

/**
 * The draft's saved screenshots on Edit Draft (docs/V2_ARCHITECTURE.md §2.5, §14.2): read-only, because screenshots
 * belong to the trade rather than to a revision. Each thumbnail opens it in the trade's gallery viewer, where it can be
 * relabelled or removed; saving a new revision keeps all of them.
 */

export function savedEvidenceSummary(count: number): string {
  return count === 1 ? "1 screenshot is saved with this trade." : `${count} screenshots are saved with this trade.`;
}

export function SavedEvidence({ tradeId, items, now, display }: { tradeId: string; items: ExistingEvidence[]; now: string; display: TimeDisplay }) {
  const galleryHref = `/trades/${tradeId}#evidence`;
  if (!items.length) {
    return <p className="t-meta">No screenshots are saved with this draft yet.</p>;
  }
  // "Today" in the trader's own time display, so a time is never shown without its day when the days differ.
  const today = displayDay(now, display);
  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="t-meta flex items-center gap-1.5 font-medium text-text">
          <Images aria-hidden="true" className="size-4 text-text-3" />
          {savedEvidenceSummary(items.length)}
        </p>
        <Link href={galleryHref} className="inline-flex min-h-10 items-center gap-1 font-medium text-accent text-sm hover:underline pointer-coarse:min-h-11">
          Manage in the trade gallery
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      <ul aria-label="Saved screenshots" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {items.map(item => {
          const when = displayDay(item.recordedAt, display) === today ? formatTime(item.recordedAt, display) : formatDateTime(item.recordedAt, display);
          return (
            <li key={item.id} className="min-w-0">
              <Link
                href={`/trades/${tradeId}#${evidenceTileId(item.id)}`}
                className="group flex flex-col gap-1 rounded-control no-underline"
                aria-label={`${item.name}, ${item.tag}, saved ${when}. Opens in the trade gallery.`}
              >
                <span className="block overflow-hidden rounded-control border border-border bg-surface">
                  <img src={item.thumbSrc} alt="" loading="lazy" decoding="async" className="aspect-[16/10] h-auto w-full object-contain transition-opacity group-hover:opacity-90" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="t-caption truncate font-medium text-text-2">{item.tag}</span>
                  <span className="t-caption num">Saved {when}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
