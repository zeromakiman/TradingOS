import { EvidenceGallery } from "@/components/evidence/gallery";
import type { GalleryItem } from "@/components/evidence/gallery-model";
import type { TradeDetail } from "@/lib/trades-data";
import { EvidenceUploader } from "./evidence-uploader";
import type { EvidenceMode } from "./model";
import { TRADE_TARGETS } from "./reveal";
import { WorkspaceSection } from "./section";

/**
 * Evidence section (docs/V2_ARCHITECTURE.md §2.5, §7.1, §7.5, §14.4): the gallery grouped Before entry / While live /
 * After close with the fullscreen viewer (relabel, soft remove), the "use for AI" selection on drafts and closed trades,
 * and, while the trade has no position (a draft, a locked plan, or a plan that ended without one), the stager that
 * takes Ctrl/⌘+V and drops anywhere on the page. After entry new screenshots go through the journal composer. Server
 * component.
 */

export interface EvidenceSectionProps {
  detail: TradeDetail;
  mode: EvidenceMode;
  gallery: GalleryItem[];
  developerMode: boolean;
}

export function EvidenceSection({ detail, mode, gallery, developerMode }: EvidenceSectionProps) {
  const { activeCount, limit } = detail.evidence;
  const staging = mode.pasteTo === "evidence";
  const removed = gallery.filter(item => item.removed).length;
  // Without a position the stager's drop zone is the empty state; the gallery appears with the first screenshot.
  const showGallery = activeCount > 0 || !staging;
  return (
    <WorkspaceSection id={TRADE_TARGETS.evidence} title="Evidence" meta={`${activeCount} of ${limit} screenshots`} bodyClassName="gap-4">
      {showGallery && <EvidenceGallery items={gallery} tradeId={detail.tradeId} selectable={mode.selectable} developerMode={developerMode} />}
      {!showGallery && removed > 0 && (
        <p className="t-caption">{removed === 1 ? "1 removed screenshot is" : `${removed} removed screenshots are`} kept in the timeline.</p>
      )}
      {staging ? (
        <EvidenceUploader tradeId={detail.tradeId} defaultLabel={mode.defaultLabel} remaining={mode.remaining} />
      ) : (
        activeCount > 0 && <p className="t-caption">To add screenshots, paste or drop them anywhere on this page, or attach them in the journal composer.</p>
      )}
    </WorkspaceSection>
  );
}
