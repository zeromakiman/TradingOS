import { TIMING_LABELS, TIMING_ORDER, type Timing } from "@/domain/timeline";
import { compareInstants } from "@/domain/time-display";
import type { EvidenceItemView } from "@/lib/trades-data";
import { evidenceDisplayName } from "./labels";
import { type EvidenceLabel, isEvidenceLabel, isTimeframe, type Timeframe } from "./types";

/**
 * View model of the evidence gallery (docs/V2_ARCHITECTURE.md §7.3–7.5). Pure, so server pages can build
 * gallery items and tests can check the grouping. V2 evidence and legacy screenshots share one shape;
 * thumbnails and full images come from the owner-only routes (`/api/evidence/[id]`,
 * `/api/screenshots/[id]`, `?variant=thumb`).
 */

export interface GalleryItem {
  /** Evidence id: the handle for relabel/remove, AI selection and `#evidence-<id>` links; never printed. */
  id: string;
  kind: "V2" | "LEGACY";
  label: EvidenceLabel;
  timeframe: Timeframe | null;
  caption: string | null;
  /** Effective timing band (`classifyTiming`, spec §5.3). */
  timing: Timing;
  /** Server time the image was recorded. */
  recordedAt: string;
  /** Soft-removed: hidden from the gallery and AI selection; the timeline keeps the record. */
  removed?: boolean;
  /** A duplicate's copy (§7.4): the original's recording time, null when it is no longer known. */
  copiedFrom?: { recordedAt: string | null };
  thumbUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  /** Sent to an AI analysis or review of this trade. */
  usedByAi?: boolean;
  /** Timing flags in words, for example "Recorded after execution began". */
  flags?: readonly string[];
}

export interface GalleryBand {
  timing: Timing;
  /** "Before entry", "While live" or "After close". */
  label: string;
  items: GalleryItem[];
}

function byRecordedAt(a: GalleryItem, b: GalleryItem): number {
  let order = 0;
  try {
    order = compareInstants(a.recordedAt, b.recordedAt);
  } catch {
    order = a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0;
  }
  return order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Active items grouped by timing band in band order, oldest first; empty bands are left out. */
export function galleryBands(items: readonly GalleryItem[]): GalleryBand[] {
  const active = items.filter(item => !item.removed);
  return TIMING_ORDER.map(timing => ({ timing, label: TIMING_LABELS[timing], items: active.filter(item => item.timing === timing).sort(byRecordedAt) }))
    .filter(band => band.items.length > 0);
}

/** "M5 chart", "Entry screenshot". */
export function galleryItemName(item: Pick<GalleryItem, "label" | "timeframe">): string {
  return evidenceDisplayName(item.label, item.timeframe);
}

export const EVIDENCE_HASH_PREFIX = "#evidence-";

/**
 * Link that opens the gallery viewer on one screenshot (timeline thumbnails, AI source chips): the
 * gallery listens for this hash and opens its viewer; without a gallery the browser scrolls to the tile.
 */
export function evidenceHref(id: string): string {
  return `${EVIDENCE_HASH_PREFIX}${id}`;
}

/** DOM id of a gallery tile, the target of `evidenceHref`. */
export function evidenceTileId(id: string): string {
  return `evidence-${id}`;
}

/** The evidence id of an `#evidence-<id>` hash, else null. */
export function evidenceIdFromHash(hash: string): string | null {
  if (!hash.startsWith(EVIDENCE_HASH_PREFIX)) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(EVIDENCE_HASH_PREFIX.length));
  } catch {
    return null;
  }
  return id.trim() === "" ? null : id;
}

/** The fields of the trade detail's evidence view (`TradeDetail.evidence.items`) the gallery uses. */
export type EvidenceViewSource = Pick<
  EvidenceItemView,
  "id" | "kind" | "label" | "timeframe" | "caption" | "timing" | "flags" | "recordedAt" | "removedAt" | "copied" | "copiedFromRecordedAt" | "src" | "thumbSrc" | "width" | "height"
>;

/** A gallery item from one `EvidenceItemView` of `getTradeDetail` (src/lib/trades-data.ts). */
export function toGalleryItem(view: EvidenceViewSource, options: { usedByAi?: boolean } = {}): GalleryItem {
  return {
    id: view.id,
    kind: view.kind,
    label: isEvidenceLabel(view.label) ? view.label : "OTHER",
    timeframe: isTimeframe(view.timeframe) ? view.timeframe : null,
    caption: view.caption && view.caption.trim() !== "" ? view.caption : null,
    timing: view.timing,
    recordedAt: view.recordedAt,
    removed: view.removedAt !== null,
    ...(view.copied ? { copiedFrom: { recordedAt: view.copiedFromRecordedAt } } : {}),
    thumbUrl: view.thumbSrc,
    fullUrl: view.src,
    width: view.width,
    height: view.height,
    usedByAi: options.usedByAi ?? false,
    flags: view.flags,
  };
}

/** Gallery items of a trade; `usedByAi` lists the evidence ids sent to an AI request of this trade. */
export function toGalleryItems(views: readonly EvidenceViewSource[], options: { usedByAi?: Iterable<string> } = {}): GalleryItem[] {
  const used = new Set(options.usedByAi ?? []);
  return views.map(view => toGalleryItem(view, { usedByAi: used.has(view.id) }));
}
