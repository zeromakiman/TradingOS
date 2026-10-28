import type { GalleryItem } from "@/components/evidence/gallery-model";
import { JournalComposer } from "@/components/trade/journal/composer";
import { TradeTimeline } from "@/components/trade/journal/timeline";
import { plural } from "@/domain/format";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { type EvidenceMode, newEntriesLabel } from "./model";
import { TRADE_TARGETS } from "./reveal";
import { WorkspaceSection } from "./section";

/**
 * Journal section (docs/V2_ARCHITECTURE.md §3.6, §5.3–5.4, §7.1, §14.4): the trade's timeline grouped Before entry /
 * While live / After close with exact times and flags, then the composer ("Add to trade journal…", kind chips Note ·
 * Decision · Stop · Target · Partial · Lesson, screenshots, Ctrl/⌘+Enter). While the position is live the composer
 * docks above the tab bar on phones, and Ctrl/⌘+V anywhere on the page attaches screenshots to it. `#journal` opens the
 * page with the composer focused (`TradeHashFocus`). Server component.
 */

export interface JournalSectionProps {
  detail: TradeDetail;
  display: TimeDisplay;
  developerMode: boolean;
  mode: EvidenceMode;
  gallery: readonly GalleryItem[];
  composerKey: string;
  sticky: boolean;
}

export function JournalSection({ detail, display, developerMode, mode, gallery, composerKey, sticky }: JournalSectionProps) {
  const count = detail.timeline.length;
  return (
    <WorkspaceSection
      id={TRADE_TARGETS.journal}
      title="Journal"
      meta={`${plural(count, "record")} · new entries: ${newEntriesLabel(detail, mode)}`}
      bodyClassName="gap-4"
    >
      <TradeTimeline items={detail.timeline} timeDisplay={display} developerMode={developerMode} evidence={gallery} />
      {detail.timelineTruncated && <p className="t-caption">This trade has more records than the page shows; the oldest ones may be missing here.</p>}
      <JournalComposer
        tradeId={detail.tradeId}
        timingHint={mode.timingHint}
        defaultLabel={mode.defaultLabel}
        instrument={detail.instrument ? { tickSize: detail.instrument.tickSize, quantityStep: detail.instrument.quantityStep } : null}
        requestKey={composerKey}
        sticky={sticky}
        capture={mode.pasteTo === "journal" ? "page" : "composer"}
        maxScreenshots={mode.remaining}
        // The kind chips scroll sideways on phones; their visually hidden radios are absolutely positioned, so the row
        // must be their containing block or the off-screen ones widen the page past the viewport.
        className="[&_.filter-chips]:relative"
      />
    </WorkspaceSection>
  );
}
