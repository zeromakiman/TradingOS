// biome-ignore-all lint/performance/noImgElement: owner-only evidence thumbnails are served privately (no-store) and must not enter the image optimizer cache.
import {
  Activity, Ban, ChartPie, CircleCheck, FilePen, History, Image as ImageIcon, ImageOff, Lightbulb, Lock, LogIn, LogOut, type LucideIcon,
  MessageSquareText, RotateCcw, Scale, Shield, ShieldCheck, Signpost, Sparkles, StickyNote, Tags, Target, Trash2, TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { evidenceHref, type GalleryItem, galleryItemName } from "@/components/evidence/gallery-model";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { TechnicalDetails } from "@/components/ui/technical-details";
import type { TimeDisplay } from "@/domain/time-display";
import { groupByTiming, type JournalKind, TIMING_FLAG_COPY, type TimelineItem, type TimelineKind } from "@/domain/timeline";
import { spansSeveralDays, timelineTime } from "./timeline-model";

/**
 * Trade timeline (docs/V2_ARCHITECTURE.md §5.3–5.4, §14.4): the items of `buildTimeline` in three bands,
 * Before entry · While live · After close, each item with its exact time ("09:42 · recorded 10:15" when
 * recorded more than five minutes later), the "Recorded after execution began" flag, journal details in
 * plain words, inline screenshot thumbnails that open the gallery viewer, compact AI rows and removal
 * records. Each item's DOM id is its `TimelineItem.id`, so `#journal:<id>` links scroll to it. Raw ids,
 * sources and details live in a collapsed Technical details block. Renders on the server or the client.
 */

export interface TradeTimelineProps {
  items: TimelineItem[];
  timeDisplay: TimeDisplay;
  developerMode?: boolean;
  /** Gallery items of the trade (including removed ones) for inline thumbnails; without it evidence rows show no image. */
  evidence?: readonly GalleryItem[];
  /** Heading level of the band titles (default 3, under the Live journal section's h2). */
  headingLevel?: 3 | 4;
}

const KIND_ICONS: Readonly<Record<TimelineKind, LucideIcon>> = {
  DRAFT_REVISION: FilePen,
  RISK_CHECK: ShieldCheck,
  PLAN_LOCKED: Lock,
  NOTE: StickyNote,
  TRADE_EVENT: Activity,
  ENTRY: LogIn,
  SIZE_DEVIATION: Scale,
  JOURNAL: MessageSquareText,
  EVIDENCE_ADDED: ImageIcon,
  EVIDENCE_REMOVED: ImageOff,
  TAGS: Tags,
  DISPOSITION: Ban,
  CLOSE: LogOut,
  AI_ANALYSIS: Sparkles,
  REVIEW_COMPLETED: CircleCheck,
  REVIEW_REOPENED: RotateCcw,
  DRAFT_DISCARDED: Trash2,
};

const JOURNAL_ICONS: Readonly<Record<JournalKind, LucideIcon>> = {
  NOTE: MessageSquareText,
  DECISION: Signpost,
  STOP_CHANGE: Shield,
  TARGET_CHANGE: Target,
  PARTIAL_CLOSE: ChartPie,
  LESSON: Lightbulb,
};

function iconOf(item: TimelineItem): LucideIcon {
  if (item.kind === "JOURNAL" && item.journalKind) return JOURNAL_ICONS[item.journalKind];
  return Object.hasOwn(KIND_ICONS, item.kind) ? KIND_ICONS[item.kind] : History;
}

export function TradeTimeline({ items, timeDisplay, developerMode, evidence = [], headingLevel = 3 }: TradeTimelineProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        icon={<History />}
        title="Nothing recorded yet."
        description="Notes, decisions, stop and target changes and screenshots appear here in the order they happened."
      />
    );
  }
  const bands = groupByTiming(items).filter(band => band.items.length > 0);
  const withDay = spansSeveralDays(items, timeDisplay);
  const evidenceById = new Map(evidence.map(item => [item.id, item] as const));
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="flex flex-col gap-5">
      {bands.map(band => (
        <section key={band.timing} className="flex flex-col gap-1">
          <Heading className="flex items-baseline gap-2 text-sm font-semibold text-text">
            {band.label}
            <span className="t-caption num font-normal">
              {band.items.length}
              <span className="sr-only"> record{band.items.length === 1 ? "" : "s"}</span>
            </span>
          </Heading>
          <ol className="ml-3 border-l border-border pl-5">
            {band.items.map(item => (
              <TimelineRow key={item.id} item={item} display={timeDisplay} withDay={withDay} evidence={item.evidenceId ? evidenceById.get(item.evidenceId) : undefined} />
            ))}
          </ol>
        </section>
      ))}
      <TechnicalDetails developerMode={developerMode}>
        <ol className="flex flex-col gap-2 font-mono text-xs">
          {items.map(item => (
            <li key={item.id} className="break-all">
              {item.id} · {item.kind}
              {item.journalKind ? `/${item.journalKind}` : ""} · {item.timing}
              {item.flags.length ? ` [${item.flags.join(", ")}]` : ""} · source {item.source} · at {item.at} · recorded {item.recordedAt}
              {item.details && Object.keys(item.details).length > 0 ? ` · details ${JSON.stringify(item.details)}` : ""}
            </li>
          ))}
        </ol>
      </TechnicalDetails>
    </div>
  );
}

function TimelineRow({ item, display, withDay, evidence }: { item: TimelineItem; display: TimeDisplay; withDay: boolean; evidence: GalleryItem | undefined }) {
  const Icon = iconOf(item);
  const compact = item.kind === "AI_ANALYSIS";
  const time = safeTime(item, display, withDay);
  return (
    <li id={item.id} className={cx("relative scroll-mt-24", compact ? "py-1.5" : "py-2.5")}>
      <span aria-hidden="true" className="absolute top-2.5 -left-[2.0625rem] grid size-6 place-items-center rounded-full border border-border bg-surface text-text-2">
        <Icon className="size-3.5" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className={cx("min-w-0 flex-1", compact ? "t-meta" : "font-medium text-text")}>{item.title}</p>
        <time dateTime={item.at} title={time.full} className="t-caption num shrink-0">
          {time.main}
          {time.recorded && <span> · recorded {time.recorded}</span>}
        </time>
      </div>
      {item.flags.map(flag => (
        <p key={flag} className="t-caption mt-0.5 flex items-center gap-1 text-warn">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {TIMING_FLAG_COPY[flag]}
        </p>
      ))}
      {item.body && <p className={cx("mt-1 whitespace-pre-wrap break-words", compact ? "t-caption line-clamp-2" : "text-text-2")}>{item.body}</p>}
      {item.kind === "EVIDENCE_ADDED" && evidence && <EvidenceThumbnail item={evidence} />}
    </li>
  );
}

function EvidenceThumbnail({ item }: { item: GalleryItem }): ReactNode {
  const name = galleryItemName(item);
  if (item.removed) return <p className="t-caption mt-1">Removed from the gallery later.</p>;
  return (
    <a href={evidenceHref(item.id)} className="mt-2 block w-40 overflow-hidden rounded-control border border-border bg-surface-sunken hover:border-border-strong">
      <img src={item.thumbUrl} alt={`Open ${name}`} loading="lazy" decoding="async" width={item.width} height={item.height} className="aspect-[16/10] h-auto w-full object-contain" />
    </a>
  );
}

function safeTime(item: TimelineItem, display: TimeDisplay, withDay: boolean): { main: string; recorded: string | null; full: string } {
  try {
    return timelineTime(item, display, withDay);
  } catch {
    return { main: item.timeLabel, recorded: null, full: item.timeLabel };
  }
}
