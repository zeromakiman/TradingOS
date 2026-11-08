import { staleRevisionLabel } from "@/domain/ai-summary";
import { formatDateTime, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import type { AiHistoryOperation, AiHistoryRow, ResolvedAiCard, RevisionMarker } from "@/lib/ai-history";
import { AiCard, type AiHeadlineModel } from "./ai-card";
import { FullAnalysisSheet, type FullAnalysisSheetProps } from "./full-analysis-sheet";
import {
  type AiFactModel, type AiRiskLine, assessmentModels, citationsOf, failureAccountingText, NO_PLAN_RECORDED, sectionModels, sourceChipModel, VIEW_FULL_ANALYSIS,
} from "./model";
import { periodicFactModels, storedPeriodicFacts } from "./periodic";
import { AiTechnicalFields, CitationIds } from "./technical";

/**
 * One card per AI operation (docs/V2_ARCHITECTURE.md §11.1), composed from the shapes src/lib/ai-history.ts returns:
 * the history row (`historyRow`: status, labels, failure, technical fields) and its resolved summary card
 * (`resolvedCard`, built by the domain summarizers with friendly source chips). Deterministic facts (Risk Engine line,
 * sample size, net R, plan status) are passed separately and rendered apart from the AI interpretation. Every
 * completed result, the latest one and every earlier one in the history, opens in full in the same side sheet.
 */

/** A history row with its resolved card (null unless completed), as the ai-history based loaders return it. */
export interface AiResultEntry extends AiHistoryRow {
  card: ResolvedAiCard | null;
}

/** Pre-trade rows also carry the draft revision they analysed. */
export interface PreTradeResultEntry extends AiResultEntry {
  revision?: RevisionMarker;
}

/**
 * A history row as the AI history list takes it: whatever the loaders and panels know about it beyond `AiHistoryRow`.
 * A completed row with a `card` opens in full; the other fields fill the deterministic part of that full analysis.
 */
export interface AiHistoryEntry extends AiHistoryRow {
  /** Pre-trade analyses: the draft revision analysed. */
  revision?: RevisionMarker;
  /** Periodic reviews: the period in words, for example "Week of Oct 6–12" or "Last 12 trades (20 requested)". */
  scopeLabel?: string;
  /** The resolved summary card of a completed row. */
  card?: ResolvedAiCard | null;
  /** Pre-trade analyses: the Risk Engine verdict stored with the request (never today's verdict). */
  riskLine?: AiRiskLine | null;
  /** Trade reviews of live-first and imported trades: "No pre-trade plan recorded". */
  noPlan?: boolean;
  /** Periodic reviews: the facts Trading OS stored with the request (sample size, net R). */
  storedFacts?: unknown;
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

/** The deterministic part of a full analysis, besides the AI's own text. */
interface AnalysisContext {
  title: string;
  riskLine?: AiRiskLine | null;
  facts?: readonly AiFactModel[];
  factsNote?: string | null;
}

interface ResultCardProps extends OperationCardBaseProps, AnalysisContext {
  entry: AiResultEntry;
  staleNote?: string | null;
}

function describe(entry: AiHistoryRow, display: TimeDisplay): string {
  const at = entry.completedAt ?? entry.requestedAt;
  try {
    return `${entry.operationLabel} · ${entry.statusLabel} · ${formatDateTime(at, display)}`;
  } catch {
    return `${entry.operationLabel} · ${entry.statusLabel}`;
  }
}

function headlineOf(entry: AiHistoryRow & { card?: ResolvedAiCard | null }): AiHeadlineModel | null {
  if (entry.card) return { label: entry.card.headlineTitle, text: entry.card.headline.text, sources: entry.card.headline.sources.map(sourceChipModel) };
  return entry.headline ? { text: entry.headline, sources: [] } : null;
}

interface SheetOptions {
  staleNote?: string | null;
  developerMode?: boolean;
  timeDisplay?: TimeDisplay;
  /** History rows: a compact link whose accessible name names the row. */
  compactTrigger?: boolean;
}

/** "View full analysis" of a completed result: every section and item in full, every citation, the deterministic facts. */
function resultSheetProps(entry: AiHistoryRow, card: ResolvedAiCard, context: AnalysisContext, options: SheetOptions): FullAnalysisSheetProps {
  const display = options.timeDisplay ?? STRATEGY_TIME;
  return {
    title: context.title,
    description: [describe(entry, display), options.staleNote].filter(Boolean).join(" · "),
    sections: sectionModels(card.full),
    riskLine: context.riskLine,
    assessments: assessmentModels(card.chips),
    facts: context.facts,
    factsNote: context.factsNote,
    limitations: card.limitations,
    technical: <AiTechnicalFields technical={entry.technical} status={entry.status} />,
    developerMode: options.developerMode,
    triggerStyle: options.compactTrigger ? "link" : "button",
    triggerAriaLabel: options.compactTrigger ? `${VIEW_FULL_ANALYSIS} · ${describe(entry, display)}` : undefined,
  };
}

function ResultCard({ entry, title, riskLine, staleNote, facts = [], factsNote, developerMode, timeDisplay = STRATEGY_TIME, headingLevel, className }: ResultCardProps) {
  const { card } = entry;
  const assessments = card ? assessmentModels(card.chips) : [];
  const headline = headlineOf(entry);
  const fullSections = card ? sectionModels(card.full) : [];
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
      onOpenFull={card ? <FullAnalysisSheet {...resultSheetProps(entry, card, { title, riskLine, facts, factsNote }, { staleNote, developerMode, timeDisplay })} /> : undefined}
      technical={
        <div className="flex flex-col gap-3">
          <AiTechnicalFields technical={entry.technical} status={entry.status} />
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

/**
 * The card of a trade review in the format it was written in: a stored V1 review (REVIEW_TRADE, history only; V2
 * requests the timeline-aware review) shows its dimension chips, a timeline review its assessments. Both come from
 * the entry's card, resolved by the request's stored contract.
 */
export function TradeReviewCard({ entry, noPlan, facts, ...rest }: TradeReviewCardProps) {
  return <ResultCard entry={entry} title="Trade review" facts={tradeFacts(noPlan, facts)} {...rest} />;
}

/** "From Trading OS" of a periodic review: sample size and net R from the facts stored with the request. */
function periodicStrip(storedFacts: unknown): { facts: AiFactModel[]; note: string | null } {
  const facts = storedPeriodicFacts(storedFacts);
  const strip = facts ? periodicFactModels(facts) : null;
  return { facts: strip?.facts ?? [], note: strip?.note ?? null };
}

function PeriodicCard({ entry, storedFacts, title, scopeLabel, fallbackTitle, ...rest }: PeriodicCardProps & { fallbackTitle: string }) {
  const strip = periodicStrip(storedFacts);
  return <ResultCard entry={entry} title={title ?? scopeLabel ?? fallbackTitle} facts={strip.facts} factsNote={strip.note} {...rest} />;
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

/** Each operation's card title, as its card names it. */
const CARD_TITLES: Readonly<Record<AiHistoryOperation, string>> = {
  ANALYZE_SETUP: "Setup analysis", CHALLENGE_BIAS: "Bias challenge", REVIEW_TRADE: "Trade review", REVIEW_TRADE_TIMELINE: "Trade review",
  WEEKLY_REVIEW: "Weekly review", RECENT_TRADES_ANALYSIS: "Recent trades", MONTHLY_REVIEW: "Monthly review",
};

/** The same deterministic part the operation's card shows: the stored Risk Engine verdict, the plan status or the sample. */
function historyContext(entry: AiHistoryEntry): AnalysisContext {
  const title = CARD_TITLES[entry.operation];
  switch (entry.operation) {
    case "ANALYZE_SETUP":
    case "CHALLENGE_BIAS":
      return { title, riskLine: entry.riskLine ?? null };
    case "REVIEW_TRADE":
    case "REVIEW_TRADE_TIMELINE":
      return { title, facts: tradeFacts(entry.noPlan) };
    default: {
      const strip = periodicStrip(entry.storedFacts);
      return { title: entry.scopeLabel ?? title, facts: strip.facts, factsNote: strip.note };
    }
  }
}

/**
 * The full analysis of one history row (§11.1): an earlier result reads in full exactly as the latest card's sheet
 * does. Null for rows that did not complete or carry no card.
 */
export function historyFullAnalysis(entry: AiHistoryEntry, options: { developerMode?: boolean; timeDisplay?: TimeDisplay } = {}): FullAnalysisSheetProps | null {
  if (entry.status !== "COMPLETED" || !entry.card) return null;
  return resultSheetProps(entry, entry.card, historyContext(entry), { ...options, staleNote: entry.revision?.staleLabel ?? null, compactTrigger: true });
}

/** "View full analysis" of one history row; nothing for rows that did not complete or carry no card. */
export function HistoryFullAnalysis({ entry, developerMode, timeDisplay }: { entry: AiHistoryEntry; developerMode?: boolean; timeDisplay?: TimeDisplay }) {
  const props = historyFullAnalysis(entry, { developerMode, timeDisplay });
  return props ? <FullAnalysisSheet {...props} /> : null;
}

/** The newest completed result of a newest-first list, if any. */
export function latestCompleted<T extends AiHistoryRow>(entries: readonly T[]): T | null {
  return entries.find(entry => entry.status === "COMPLETED") ?? null;
}
