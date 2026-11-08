import { unstable_rethrow } from "next/navigation";
import { useId } from "react";
import { requestTradeTimelineReview } from "@/app/actions/ai";
import type { TimeDisplay } from "@/domain/time-display";
import { loadTradeAiHistory, type TradeAiHistory } from "@/lib/ai-history";
import { loadTradeTimelineReviewPanel, type TradeTimelineReviewPanel } from "@/lib/trade-timeline-review-data";
import { Callout } from "../ui/callout";
import { SectionHeader } from "../ui/page-header";
import { AiEvidenceActions } from "./ai-evidence-actions";
import { AiHistoryList } from "./ai-history-list";
import { AiSettingsLink } from "./ai-settings-link";
import { estimateModel } from "./estimate";
import { NO_PLAN_RECORDED } from "./model";
import { type AiResultEntry, latestCompleted, TradeReviewCard } from "./operation-cards";
import { availabilityReason, displayPreference, optional } from "./panel-data";

/**
 * AI review of a trade (docs/V2_ARCHITECTURE.md §2.4, §11.1, §11.4): "Review this trade · ≈ €0.02" once the trade is
 * closed (any origin), the latest review as a concise card in the format it was written in (a review made with the
 * earlier V1 format shows its dimension chips and lessons), and every review in the history, each of which opens in
 * full. Loads its own data with the user's session; nothing runs on page load.
 */

export interface TradeReviewAiPanelProps {
  tradeId: string;
  /** The trade's trading account (AI settings and budgets are per account). */
  accountId: string;
  /**
   * The account is archived: it can't be selected as a context (§9.2) and its AI settings change only after a restore,
   * so AI off or a reached limit points to Manage account.
   */
  accountArchived?: boolean;
  /** Closed (or reviewed) trades can be reviewed; open trades only show their history. */
  closed: boolean;
  /** Live-first and imported trades: the review states that no pre-trade plan exists. */
  noPlan: boolean;
  developerMode?: boolean;
}

const ADVISORY = "Advisory only. Your trade records never change, and nothing is sent until you ask for a review.";
const REVIEW_UNAVAILABLE = "Trade review is unavailable right now. Your trade records are unaffected.";

interface ViewProps extends TradeReviewAiPanelProps {
  panel: TradeTimelineReviewPanel;
  history: TradeAiHistory | null;
  timeDisplay: TimeDisplay;
  requestKey: string;
}

/**
 * Every review of the trade, newest first, each with its card: the full trade history (V1 and timeline-aware reviews)
 * when it loaded, else the review panel's own page of timeline reviews. A timeline review keeps the panel's card, whose
 * screenshot chips are named after the trade's evidence.
 */
export function tradeReviewEntries(panel: Pick<TradeTimelineReviewPanel, "history">, history: TradeAiHistory | null, noPlan: boolean): (AiResultEntry & { noPlan: boolean })[] {
  if (history === null || history.error !== null) return panel.history.map(entry => ({ ...entry, card: entry.card ?? null, noPlan }));
  const panelCards = new Map(panel.history.map(entry => [entry.technical.requestId, entry.card] as const));
  return history.reviews.map(row => ({ ...row, card: panelCards.get(row.technical.requestId) ?? row.card ?? null, noPlan }));
}

function TradeReviewAiPanelView({ tradeId, accountId, accountArchived, closed, noPlan, developerMode, panel, history, timeDisplay, requestKey }: ViewProps) {
  const headingId = useId();
  const complete = history !== null && history.error === null;
  const rows = tradeReviewEntries(panel, history, noPlan);
  const latest = latestCompleted(rows);
  if (!closed && rows.length === 0) return null;
  const available = !panel.error && panel.availability.status === "ENABLED";
  const needsSettings = closed && (panel.availability.status === "ACCOUNT_OFF" || panel.availability.status === "BUDGET_REACHED");

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-panel="trade-review-ai">
      <SectionHeader as="h3" id={headingId} title="AI review" description={ADVISORY} className="mb-0" />
      {noPlan && !latest && <p className="t-meta">{NO_PLAN_RECORDED}, so a review can't compare the execution with a plan.</p>}
      {closed ? (
        <AiEvidenceActions
          buttons={[
            {
              operation: "REVIEW_TRADE_TIMELINE",
              label: "Review this trade",
              action: requestTradeTimelineReview,
              payload: { tradeId },
              requestKey,
              estimate: estimateModel(panel.estimate),
              available,
              unavailableReason: panel.error ? REVIEW_UNAVAILABLE : availabilityReason({ ...panel.availability, accountArchived }),
              secondary: true,
            },
          ]}
          eligibleEvidenceIds={panel.evidence.map(item => item.id)}
          maxEvidence={panel.maxEvidence}
        />
      ) : (
        <p className="t-meta">Close the trade to request an AI review.</p>
      )}
      {needsSettings && <AiSettingsLink accountId={accountId} archived={accountArchived} />}
      {latest && <TradeReviewCard entry={latest} noPlan={noPlan} developerMode={developerMode} timeDisplay={timeDisplay} headingLevel={4} />}
      <div className="flex flex-col gap-2">
        <h4 className="text-[0.8125rem] font-semibold text-text">History</h4>
        {/* Only planned trades can have reviews in the earlier format, which the fallback list does not include. */}
        {!complete && !noPlan && <p className="t-caption">Some earlier reviews could not be loaded right now. Trade records are unaffected.</p>}
        <AiHistoryList rows={rows} developerMode={developerMode} timeDisplay={timeDisplay} limit={5} label="Trade review history" emptyText="No reviews yet." />
      </div>
    </section>
  );
}

export async function TradeReviewAiPanel(props: TradeReviewAiPanelProps) {
  let loaded: [TradeTimelineReviewPanel, TradeAiHistory | null];
  try {
    loaded = await Promise.all([loadTradeTimelineReviewPanel(props.tradeId), optional(loadTradeAiHistory(props.tradeId, { cards: true }))]);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Callout tone="neutral" title="AI review is unavailable">
        AI reviews could not be loaded for this trade. Trade records are unaffected.
      </Callout>
    );
  }
  const [panel, history] = loaded;
  return <TradeReviewAiPanelView {...props} panel={panel} history={history} timeDisplay={await displayPreference()} requestKey={crypto.randomUUID()} />;
}
