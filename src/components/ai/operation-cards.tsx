import { staleRevisionLabel } from "@/domain/ai-summary";
import { formatDateTime, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import type { AiHistoryRow, ResolvedAiCard, RevisionMarker } from "@/lib/ai-history";
import { AiCard, type AiHeadlineModel } from "./ai-card";
import { FullAnalysisSheet } from "./full-analysis-sheet";
import { type AiFactModel, type AiRiskLine, assessmentModels, citationsOf, failureAccountingText, NO_PLAN_RECORDED, sectionModels, sourceChipModel } from "./model";
import { periodicFactModels, storedPeriodicFacts } from "./periodic";
import { AiTechnicalFields, CitationIds } from "./technical";

/**
 * One card per AI operation (docs/V2_ARCHITECTURE.md §11.1), composed from the shapes src/lib/ai-history.ts returns:
 * the history row (`historyRow`: status, labels, failure, technical fields) and its resolved summary card
 * (`resolvedCard`, built by the domain summarizers with friendly source chips). Deterministic facts (Risk Engine line,
 * sample size, net R, plan status) are passed separately and rendered apart from the AI interpretation.
 */

/** A history row with its resolved card (null unless completed), as the ai-history based loaders return it. */
export interface AiResultEntry extends AiHistoryRow {
  card: ResolvedAiCard | null;
}

/** Pre-trade rows also carry the draft revision they analysed. */
export interface PreTradeResultEntry extends AiResultEntry {
  revision?: RevisionMarker;
}

interface OperationCardBaseProps {
  developerMode?: boolean;
  timeDisplay?: TimeDisplay;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

export interface PreTradeCardProps extends OperationCardBaseProps {
  entry: PreTradeResultEntry;
  /** The deterministic Risk Engine line that leads the card. */
  riskLine?: AiRiskLine | null;
  /** The draft's current revision; an analysis of an earlier revision is marked stale. Defaults to the entry's marker. */
  currentRevision?: number;
}

export interface TradeReviewCardProps extends OperationCardBaseProps {
  entry: AiResultEntry;
  /** Live-first and imported trades: "No pre-trade plan recorded" in the From Trading OS strip. */
  noPlan?: boolean;
  /** Further deterministic facts about the trade, for example the realized R. */
  facts?: readonly AiFactModel[];
}

export interface PeriodicCardProps extends OperationCardBaseProps {
  entry: AiResultEntry;
  /**
   * Facts Trading OS stored with the request (`facts` column). Only the sample size and net R are read; they fill the
   * From Trading OS strip.
   */
  storedFacts?: unknown;
  /** Card title; defaults to the period, for example "Week of Oct 6–12". */
  title?: string;
  /** The period in words, for example "Week of Oct 6–12" (periodic history rows carry it as `scopeLabel`). */
  scopeLabel?: string;
}

interface ResultCardProps extends OperationCardBaseProps {
  entry: AiResultEntry;
  title: string;
  riskLine?: AiRiskLine | null;
  staleNote?: string | null;
  facts?: readonly AiFactModel[];
  factsNote?: string | null;
}

function describe(entry: AiResultEntry, display: TimeDisplay): string {
  const at = entry.completedAt ?? entry.requestedAt;
  try {
    return `${entry.operationLabel} · ${entry.statusLabel} · ${formatDateTime(at, display)}`;
  } catch {
    return `${entry.operationLabel} · ${entry.statusLabel}`;
  }
}

function headlineOf(entry: AiResultEntry): AiHeadlineModel | null {
  if (entry.card) return { label: entry.card.headlineTitle, text: entry.card.headline.text, sources: entry.card.headline.sources.map(sourceChipModel) };
  return entry.headline ? { text: entry.headline, sources: [] } : null;
}

function ResultCard({ entry, title, riskLine, staleNote, facts = [], factsNote, developerMode, timeDisplay = STRATEGY_TIME, headingLevel, className }: ResultCardProps) {
  const { card } = entry;
  const assessments = card ? assessmentModels(card.chips) : [];
  const headline = headlineOf(entry);
  const fullSections = card ? sectionModels(card.full) : [];
  const fields = <AiTechnicalFields technical={entry.technical} status={entry.status} />;
  return (
    <AiCard
      title={title}
      operationLabel={entry.operationLabel}
      completedAt={entry.completedAt ?? entry.requestedAt}
      status={entry.status}
      riskLine={riskLine}
      staleNote={staleNote}
      headline={headline}
      assessments={assessments}
      sections={card ? sectionModels(card.sections) : []}
      facts={facts}
      factsNote={factsNote}
      failure={entry.status === "FAILED" ? { reason: entry.failureReason ?? "The request did not complete.", accounting: failureAccountingText(entry.technical) } : null}
      onOpenFull={
        card ? (
          <FullAnalysisSheet
            title={title}
            description={describe(entry, timeDisplay)}
            sections={fullSections}
            riskLine={riskLine}
            assessments={assessments}
            facts={facts}
            factsNote={factsNote}
            limitations={card.limitations}
            technical={fields}
            developerMode={developerMode}
          />
        ) : undefined
      }
      technical={
        <div className="flex flex-col gap-3">
          {fields}
          <CitationIds citations={citationsOf(fullSections, headline)} />
        </div>
      }
      developerMode={developerMode}
      timeDisplay={timeDisplay}
      headingLevel={headingLevel}
      className={className}
    />
  );
}

function preTradeStale(entry: PreTradeResultEntry, currentRevision: number | undefined): string | null {
  if (!entry.revision) return null;
  return currentRevision === undefined ? entry.revision.staleLabel : staleRevisionLabel(entry.revision.number, currentRevision);
}

export function AnalyzeSetupCard({ entry, riskLine, currentRevision, ...rest }: PreTradeCardProps) {
  return <ResultCard entry={entry} title="Setup analysis" riskLine={riskLine} staleNote={preTradeStale(entry, currentRevision)} {...rest} />;
}

export function ChallengeBiasCard({ entry, riskLine, currentRevision, ...rest }: PreTradeCardProps) {
  return <ResultCard entry={entry} title="Bias challenge" riskLine={riskLine} staleNote={preTradeStale(entry, currentRevision)} {...rest} />;
}

function tradeFacts(noPlan: boolean | undefined, facts: readonly AiFactModel[] = []): AiFactModel[] {
  return noPlan ? [{ label: "Plan", value: NO_PLAN_RECORDED }, ...facts] : [...facts];
}

/** REVIEW_TRADE (V1) results: history only; V2 requests the timeline-aware review. */
export function TradeReviewV1Card({ entry, noPlan, facts, ...rest }: TradeReviewCardProps) {
  return <ResultCard entry={entry} title="Trade review" facts={tradeFacts(noPlan, facts)} {...rest} />;
}

export function TradeTimelineReviewCard({ entry, noPlan, facts, ...rest }: TradeReviewCardProps) {
  return <ResultCard entry={entry} title="Trade review" facts={tradeFacts(noPlan, facts)} {...rest} />;
}

function PeriodicCard({ entry, storedFacts, title, scopeLabel, fallbackTitle, ...rest }: PeriodicCardProps & { fallbackTitle: string }) {
  const facts = storedPeriodicFacts(storedFacts);
  const strip = facts ? periodicFactModels(facts) : null;
  return <ResultCard entry={entry} title={title ?? scopeLabel ?? fallbackTitle} facts={strip?.facts ?? []} factsNote={strip?.note ?? null} {...rest} />;
}

export function WeeklyReviewCard(props: PeriodicCardProps) {
  return <PeriodicCard {...props} fallbackTitle="Weekly review" />;
}

export function RecentTradesCard(props: PeriodicCardProps) {
  return <PeriodicCard {...props} fallbackTitle="Recent trades" />;
}

export function MonthlyReviewCard(props: PeriodicCardProps) {
  return <PeriodicCard {...props} fallbackTitle="Monthly review" />;
}

/** The newest completed result of a newest-first list, if any. */
export function latestCompleted<T extends AiResultEntry>(entries: readonly T[]): T | null {
  return entries.find(entry => entry.status === "COMPLETED") ?? null;
}
