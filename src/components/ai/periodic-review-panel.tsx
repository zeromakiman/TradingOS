import { unstable_rethrow } from "next/navigation";
import { type ComponentType, useId } from "react";
import { requestMonthlyAiReview, requestRecentTradesAiReview, requestWeeklyAiReview } from "@/app/actions/ai";
import { plural } from "@/domain/format";
import type { TimeDisplay } from "@/domain/time-display";
import { runningRecentSample } from "@/lib/recent-trades-running";
import { Callout } from "../ui/callout";
import { SectionHeader } from "../ui/page-header";
import { AiActionButton, type AiRequestAction } from "./ai-action-button";
import { AiHistoryList } from "./ai-history-list";
import { AiSettingsLink } from "./ai-settings-link";
import { PERIODIC_LIMITATION } from "./model";
import { latestCompleted, MonthlyReviewCard, type PeriodicCardProps, RecentTradesCard, WeeklyReviewCard } from "./operation-cards";
import { availabilityReason, displayPreference, loadPeriodicAi, optional, type PeriodicAiData, PeriodError, type PeriodicKind } from "./panel-data";
import { periodicRunningBlock } from "./periodic";

/**
 * Weekly, recent-trades and monthly AI reviews of one trading account (docs/V2_ARCHITECTURE.md §11.5, §14.10): the
 * explicit scope ("FTMO 100K · Week of Oct 6–12 (UTC−5) · 8 trades"), the visible limitation about live-first and
 * imported trades, the run button with its estimate, the latest review of the period as a concise card, and the
 * period's history. Budgets, consent and scope are per account, so the panel always takes an explicit account.
 */

export type { PeriodicKind } from "./panel-data";

export interface PeriodicReviewPanelProps {
  kind: PeriodicKind;
  accountId: string;
  /** Weekly: any day of the week (`YYYY-MM-DD`); recent: 10, 20 or 30 trades; monthly: `YYYY-MM`. */
  period: string | number;
  developerMode?: boolean;
}

const TITLES: Readonly<Record<PeriodicKind, string>> = { weekly: "Weekly review", recent: "Recent trades analysis", monthly: "Monthly review" };
const RUN_VERBS: Readonly<Record<PeriodicKind, string>> = { weekly: "Review", recent: "Analyze", monthly: "Review" };
const ACTIONS: Readonly<Record<PeriodicKind, AiRequestAction>> = {
  weekly: requestWeeklyAiReview,
  recent: requestRecentTradesAiReview,
  monthly: requestMonthlyAiReview,
};
const NOTHING_TO_REVIEW: Readonly<Record<PeriodicKind, string>> = {
  weekly: "No completed trades in this week, so there is nothing to review.",
  recent: "No completed trades yet, so there is nothing to analyze.",
  monthly: "No completed trades in this month, so there is nothing to review.",
};
const CARDS: Readonly<Record<PeriodicKind, ComponentType<PeriodicCardProps>>> = {
  weekly: WeeklyReviewCard,
  recent: RecentTradesCard,
  monthly: MonthlyReviewCard,
};

/** "FTMO 100K · Week of Oct 6–12 (UTC−5) · 8 trades". */
export function periodicScopeLine(data: Pick<PeriodicAiData, "accountName" | "scopeLabel" | "trades">): string {
  return [data.accountName, data.scopeLabel, data.trades === null ? null : plural(data.trades, "trade")].filter(Boolean).join(" · ");
}

/**
 * Why the run button cannot send a request now, or undefined when it can: the scope, an empty period, the account's
 * AI availability, or a review of this period still running (another request would only be refused). Recent trades:
 * `runningSample` is the sample of the account's running analysis, which holds every sample's button.
 */
function runBlockedReason(data: PeriodicAiData, runningSample: number | null): string | undefined {
  if (data.scopeError) return data.scopeError;
  if (data.trades === 0) return NOTHING_TO_REVIEW[data.kind];
  if (data.availability.status !== "ENABLED") return availabilityReason(data.availability);
  const running = runningSample === null ? null : { sample: runningSample, selected: Number(data.payload.sample) };
  return periodicRunningBlock(data.kind, data.runLabel, data.history, running);
}

interface PanelViewProps {
  data: PeriodicAiData;
  /** Recent trades: the sample of the account's analysis still running, if any (`runningRecentSample`). */
  runningSample: number | null;
  developerMode?: boolean;
  timeDisplay: TimeDisplay;
  requestKey: string;
}

function PeriodicReviewPanelView({ data, runningSample, developerMode, timeDisplay, requestKey }: PanelViewProps) {
  const headingId = useId();
  const { kind } = data;
  const blocked = runBlockedReason(data, runningSample);
  const available = data.trades !== null && data.trades > 0 && blocked === undefined;
  const needsSettings = data.availability.status === "ACCOUNT_OFF" || data.availability.status === "BUDGET_REACHED";
  const latest = latestCompleted(data.history);
  const Card = CARDS[kind];

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-panel="periodic-ai" data-kind={kind}>
      <SectionHeader as="h2" id={headingId} title={TITLES[kind]} description={periodicScopeLine(data)} className="mb-0" />
      <Callout tone="neutral">{PERIODIC_LIMITATION}</Callout>
      <AiActionButton
        operation={data.operation}
        label={`${RUN_VERBS[kind]} ${data.runLabel}`}
        action={ACTIONS[kind]}
        payload={data.payload}
        requestKey={requestKey}
        estimate={data.estimate}
        available={available}
        unavailableReason={available ? undefined : blocked}
      />
      {needsSettings && <AiSettingsLink accountId={data.accountId} archived={data.accountArchived} />}
      {latest && <Card entry={latest} storedFacts={latest.storedFacts} scopeLabel={latest.scopeLabel} developerMode={developerMode} timeDisplay={timeDisplay} headingLevel={3} />}
      <div className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-semibold text-text">History</h3>
        {data.error && <p className="t-caption">{data.error}</p>}
        <AiHistoryList rows={data.history} developerMode={developerMode} timeDisplay={timeDisplay} limit={5} label={`${TITLES[kind]} history`} emptyText="No reviews for this period yet." />
      </div>
    </section>
  );
}

export async function PeriodicReviewPanel({ kind, accountId, period, developerMode }: PeriodicReviewPanelProps) {
  let data: PeriodicAiData;
  let runningSample: number | null;
  try {
    // An unreadable running state leaves the period's own history to hold the button (the database refuses anyway).
    [data, runningSample] = await Promise.all([loadPeriodicAi(kind, accountId, period), kind === "recent" ? optional(runningRecentSample(accountId)) : null]);
  } catch (error) {
    unstable_rethrow(error);
    return error instanceof PeriodError ? (
      <Callout tone="warning" title={TITLES[kind]}>
        {error.message}
      </Callout>
    ) : (
      <Callout tone="neutral" title="AI review is unavailable">
        This account's AI reviews could not be loaded. Trading records are unaffected.
      </Callout>
    );
  }
  return <PeriodicReviewPanelView data={data} runningSample={runningSample} developerMode={developerMode} timeDisplay={await displayPreference()} requestKey={crypto.randomUUID()} />;
}
