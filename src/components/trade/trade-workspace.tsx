import { Fragment, type ReactNode, Suspense } from "react";
import { PreTradeAiPanel } from "@/components/ai/pre-trade-ai-panel";
import { preTradePlacement } from "@/components/ai/pre-trade-placement";
import { TradeReviewAiPanel } from "@/components/ai/trade-review-ai-panel";
import { toGalleryItems } from "@/components/evidence/gallery-model";
import { EvidenceSelectionProvider } from "@/components/evidence/selection";
import { cx } from "@/components/ui/cx";
import { LoadingState, Skeleton, SkeletonText } from "@/components/ui/skeleton";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { EvidenceSection } from "./evidence-section";
import { ExecutionSection } from "./execution-section";
import { TradeHashFocus } from "./journal-focus";
import { JournalSection } from "./journal-section";
import { aiRiskDecision, aiRiskLine, duplicateNotes, evidenceMode, lockSummary, type MainSection, type WorkspaceBlock, workspaceLayout } from "./model";
import { PlanSection } from "./plan-section";
import { ResultSection } from "./result-section";
import { ReviewSection } from "./review-section";
import { TechnicalSection } from "./technical-section";
import { TradeHeader } from "./trade-header";
import { TradeProgress } from "./trade-progress";
import type { TradeExtras } from "./workspace-data";

/**
 * Trade workspace (docs/V2_ARCHITECTURE.md §14.4): header with the one next action, stepper or live-first banner, then
 * Plan · Execution · Result · Review in the main column and Journal + Evidence beside it (desktop), or one column on
 * phones whose order follows the trade: the journal leads while the position is live. Technical details close the
 * page. Once a trade is no longer a draft, its pre-trade AI analyses stay readable in a section after the Plan. Paid AI
 * panels stream in behind their own Suspense boundaries and never run anything on load. A link to one of
 * the page's targets (`/trades/<id>#close-trade`, `#record-entry`, `#review`, …) opens it once the trade is on the page
 * (`TradeHashFocus`). Server component.
 */

/** Per-request idempotency keys of the page's actions (a retry of the same submission replays it). */
export interface WorkspaceKeys {
  composer: string;
  duplicate: string;
  discard: string;
  reopen: string;
  review: string;
  entryDetails: string;
}

export function newWorkspaceKeys(): WorkspaceKeys {
  return {
    composer: crypto.randomUUID(), duplicate: crypto.randomUUID(), discard: crypto.randomUUID(), reopen: crypto.randomUUID(), review: crypto.randomUUID(),
    entryDetails: crypto.randomUUID(),
  };
}

export interface TradeWorkspaceProps {
  detail: TradeDetail;
  extras: TradeExtras;
  /** Server time of this request. */
  now: string;
  display: TimeDisplay;
  developerMode: boolean;
  keys: WorkspaceKeys;
}

/** Placeholder of a streaming AI panel; `framed` when the panel is a workspace section of its own. */
function AiPanelSkeleton({ label, framed = false }: { label: string; framed?: boolean }) {
  const skeleton = (
    <LoadingState label={label} className="flex flex-col gap-3">
      <Skeleton width="8rem" height="1.25rem" />
      <SkeletonText lines={2} />
      <div className="flex gap-2">
        <Skeleton width="10rem" height="2.5rem" />
        <Skeleton width="10rem" height="2.5rem" />
      </div>
    </LoadingState>
  );
  return framed ? (
    <div className="card min-w-0">
      <div className="card-body">{skeleton}</div>
    </div>
  ) : (
    skeleton
  );
}

/**
 * Desktop placement of each block (from 1280px): the main column spans both rows on the left; the other two stack in
 * a 28rem column on the right, wide enough for the composer, the timeline and 240px+ thumbnails. Narrower screens show
 * one column in DOM order.
 */
const BLOCK_CLASS: Readonly<Record<WorkspaceBlock, string>> = {
  main: "flex min-w-0 flex-col gap-5 xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:gap-6",
  journal: "min-w-0 xl:col-start-2",
  evidence: "min-w-0 xl:col-start-2",
};

export function TradeWorkspace({ detail, extras, now, display, developerMode, keys }: TradeWorkspaceProps) {
  const layout = workspaceLayout(detail);
  const mode = evidenceMode(detail);
  const lifecycle = detail.state.lifecycle;
  const gallery = toGalleryItems(detail.evidence.items);
  const lock = detail.draft ? lockSummary(detail, extras.lockUsage) : null;
  const archived = detail.account.status === "ARCHIVED";
  // Pre-trade AI tools serve a plan that can still be locked: only an open draft of an active account runs them
  // (§3.2, §9). Its analyses stay readable afterwards: in the Plan of an archived account's draft, and in a section of
  // their own once the trade is no longer a draft (only when there are any, so other trades show nothing).
  const placement = preTradePlacement({
    origin: detail.origin, lifecycle, hasDraft: detail.draft !== null, accountArchived: archived,
    requests: detail.ai.history ? detail.ai.history.preTrade.reduce((total, group) => total + group.rows.length, 0) : null,
    completed: detail.ai.activity.preTradeAnalyses,
  });
  const preTradeAi = placement ? (
    <Suspense fallback={<AiPanelSkeleton label={placement.tools ? "Loading AI tools" : "Loading pre-trade AI"} framed={placement.frame === "section"} />}>
      <PreTradeAiPanel
        tradeId={detail.tradeId}
        accountId={detail.account.id}
        accountArchived={archived}
        currentRevision={detail.draft?.revision ?? detail.revisionCount}
        riskDecision={aiRiskDecision(detail)}
        riskLine={aiRiskLine(detail)}
        frame={placement.frame}
        developerMode={developerMode}
      />
    </Suspense>
  ) : null;
  const reviewAi = lifecycle === "CLOSED" || lifecycle === "REVIEWED" ? (
    <Suspense fallback={<AiPanelSkeleton label="Loading AI review" />}>
      <TradeReviewAiPanel tradeId={detail.tradeId} accountId={detail.account.id} accountArchived={archived} closed noPlan={detail.origin !== "PLANNED"} developerMode={developerMode} />
    </Suspense>
  ) : null;

  const sections: Readonly<Record<MainSection, ReactNode>> = {
    plan: (
      <>
        <PlanSection detail={detail} extras={extras} now={now} display={display} lock={lock} discardKey={keys.discard} ai={placement?.frame === "plan" ? preTradeAi : null} />
        {placement?.frame === "section" && preTradeAi}
      </>
    ),
    execution: <ExecutionSection detail={detail} extras={extras} now={now} display={display} entryDetailsKey={keys.entryDetails} />,
    result: <ResultSection detail={detail} now={now} display={display} />,
    review: layout.review ? (
      <ReviewSection detail={detail} mode={layout.review} now={now} display={display} keys={{ review: keys.review, reopen: keys.reopen }} ai={reviewAi} />
    ) : null,
  };
  const blocks: Readonly<Record<WorkspaceBlock, ReactNode>> = {
    main: layout.main.map(key => <Fragment key={key}>{sections[key]}</Fragment>),
    journal: <JournalSection detail={detail} display={display} developerMode={developerMode} mode={mode} gallery={gallery} composerKey={keys.composer} sticky={layout.stickyComposer} />,
    evidence: <EvidenceSection detail={detail} mode={mode} gallery={gallery} developerMode={developerMode} />,
  };
  // Side blocks take the right column's rows in their DOM order.
  let row = 0;
  const grid = (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_28rem] xl:grid-rows-[auto_1fr] xl:gap-6" data-blocks={layout.blocks.join(" ")}>
      {layout.blocks.map(block => {
        const sideRow = block === "main" ? null : ++row;
        return (
          <div key={block} className={cx(BLOCK_CLASS[block], sideRow === 1 && "xl:row-start-1", sideRow === 2 && "xl:row-start-2")} data-block={block}>
            {blocks[block]}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col gap-5 lg:gap-6" data-trade-workspace={lifecycle.toLowerCase()}>
      <TradeHeader
        detail={detail}
        now={now}
        display={display}
        lock={lock}
        keys={{ duplicate: keys.duplicate, discard: keys.discard, reopen: keys.reopen }}
        duplicateNotes={duplicateNotes(detail)}
      />
      <TradeProgress detail={detail} now={now} display={display} />
      {mode.selectable ? <EvidenceSelectionProvider max={mode.max}>{grid}</EvidenceSelectionProvider> : grid}
      <TechnicalSection detail={detail} developerMode={developerMode} />
      <TradeHashFocus key={detail.tradeId} />
    </div>
  );
}
