import type { AnalyzeSetupOutput } from "@/ai/analyze-setup-contract";
import type { BiasChallengeOutput } from "@/ai/bias-challenge-contract";
import type { MonthlyReviewOutput } from "@/ai/monthly-review-contract";
import { operationFor } from "@/ai/operations";
import { operationPricing, reservationMicros } from "@/ai/pricing";
import type { RecentTradesOutput } from "@/ai/recent-trades-contract";
import type { TradeReviewOutput } from "@/ai/trade-review-contract";
import type { WeeklyReviewOutput } from "@/ai/weekly-review-contract";
import { formatR, plural } from "./format";
import { formatDay, formatMonth, formatTime, STRATEGY_TIME, type TimeDisplay } from "./time-display";

/**
 * Concise AI cards (spec §11.1) built from the existing output contracts, friendly source chips
 * and pre-call cost estimates (spec §11.2). Pure: no provider, database or clock access.
 */

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const OPERATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ANALYZE_SETUP: "Analyze Setup",
  CHALLENGE_BIAS: "Challenge My Bias",
  REVIEW_TRADE: "Trade Review",
  REVIEW_TRADE_TIMELINE: "Trade Review",
  WEEKLY_REVIEW: "Weekly Review",
  RECENT_TRADES_ANALYSIS: "Recent Trades Analysis",
  MONTHLY_REVIEW: "Monthly Review",
  SETUP_ANALYSIS: "Setup Evaluation",
  SETUP_CHALLENGE: "Setup Evaluation",
  SETUP_RECONCILE: "Setup Evaluation",
});

export function aiOperationLabel(operation: string): string {
  return Object.hasOwn(OPERATION_LABELS, operation) ? OPERATION_LABELS[operation] : "AI analysis";
}

const IN_PROGRESS = new Set(["QUEUED", "PENDING", "RUNNING", "STARTED", "IN_PROGRESS"]);

/** Request status in words; anything unrecognised reads neutrally as "Recorded". */
export function aiStatusLabel(status: string): string {
  if (status === "COMPLETED") return "Completed";
  if (status === "FAILED") return "Failed";
  return IN_PROGRESS.has(status) ? "In progress" : "Recorded";
}

/** Compact AI history row: `Analyze Setup · Completed · 08:00`. */
export function aiHistoryLabel(operation: string, status: string, at: string, display: TimeDisplay = STRATEGY_TIME): string {
  return `${aiOperationLabel(operation)} · ${aiStatusLabel(status)} · ${formatTime(at, display)}`;
}

export const STALE_ANALYSIS_NOTE = "Analysis belongs to an earlier draft version";

/** `Based on draft revision 2 · current revision is 3`, or null when the analysis is current. */
export function staleRevisionLabel(analysisRevision: number, currentRevision: number): string | null {
  return analysisRevision < currentRevision ? `Based on draft revision ${analysisRevision} · current revision is ${currentRevision}` : null;
}

// ---------------------------------------------------------------------------------------------
// First sentence
// ---------------------------------------------------------------------------------------------

/** Abbreviations that never end a sentence. */
const ABBREVIATION_END = /(?:^|\s|\()(?:e\.g|i\.e|vs|cf|approx|incl)\.$/i;
/** `No.` abbreviates "number" only before a numeral ("Trade no. 5"); "The answer is no." ends a sentence. */
const NUMBER_ABBREVIATION_END = /(?:^|\s|\()no\.$/i;
/** `etc.` ends the sentence when the next word is capitalised ("… etc. Then it reversed."). */
const ETC_END = /(?:^|\s|\()etc\.$/i;
const SENTENCE_END = /[.!?]["'”’)\]]*(?=\s|$)/g;
const ELLIPSIS = "…";

/** True when the period ending `candidate` belongs to an abbreviation, given the text that follows it. */
function continuesSentence(candidate: string, rest: string): boolean {
  if (ABBREVIATION_END.test(candidate)) return true;
  if (NUMBER_ABBREVIATION_END.test(candidate)) return /^\s+\d/.test(rest);
  if (ETC_END.test(candidate)) return !/^\s+["'“‘(]*\p{Lu}/u.test(rest);
  return false;
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const lastSpace = window.lastIndexOf(" ");
  const head = lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max - 1);
  return `${head.replace(/[\s,;:—–-]+$/, "")}${ELLIPSIS}`;
}

/** First sentence of a text, whitespace-normalised, at most `max` characters with a word-boundary ellipsis. */
export function firstSentence(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  let sentence = clean;
  for (const match of clean.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    const candidate = clean.slice(0, end);
    if (continuesSentence(candidate.replace(/["'”’)\]]+$/, ""), clean.slice(end))) continue;
    sentence = candidate;
    break;
  }
  return truncateAtWord(sentence, max);
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

export interface AiCardItem {
  text: string;
  sourceRefs: string[];
}

export interface AiCardSection {
  id: string;
  title: string;
  items: AiCardItem[];
  /** A deterministic caveat Trading OS shows with the section (never AI text); absent for most sections. */
  note?: string;
}

/**
 * The caveat under a monthly review's "What improved" and "What degraded" (kept from V1): a change claim needs
 * comparable earlier and later evidence, and complete records are not an improvement.
 */
export const CHANGE_EVIDENCE_NOTE = "Change requires comparable earlier and later evidence. Record completeness alone does not establish improvement or degradation.";

export interface AiAssessmentChip {
  id: string;
  label: string;
  assessment: string;
  assessmentLabel: string;
}

export type AiSummaryOperation = "ANALYZE_SETUP" | "CHALLENGE_BIAS" | "REVIEW_TRADE" | "REVIEW_TRADE_TIMELINE" | "WEEKLY_REVIEW" | "RECENT_TRADES_ANALYSIS" | "MONTHLY_REVIEW";

export interface AiSummaryCard {
  operation: AiSummaryOperation;
  headlineTitle: string;
  /** First sentence of the headline field (≤ 220 characters). */
  headline: AiCardItem;
  /** Concise sections: at most two first-sentence items each. */
  sections: AiCardSection[];
  chips: AiAssessmentChip[];
  /** Deterministic Trading OS facts for periodic reviews (sample size, net R); never AI text. */
  facts: string | null;
  /** Every section with full texts and all citations, for "View full analysis". */
  full: AiCardSection[];
  limitations: string[];
}

interface TextObservation { text: string; sourceRefs: readonly string[] }
interface AssessedObservation { assessment: string; interpretation: string; sourceRefs: readonly string[] }

const CARD_ITEMS = 2;

function concise(observation: TextObservation): AiCardItem {
  return { text: firstSentence(observation.text), sourceRefs: [...observation.sourceRefs] };
}

function complete(observation: TextObservation): AiCardItem {
  return { text: observation.text, sourceRefs: [...observation.sourceRefs] };
}

function section(id: string, title: string, observations: readonly TextObservation[]): AiCardSection {
  return { id, title, items: observations.slice(0, CARD_ITEMS).map(concise) };
}

function fullSection(id: string, title: string, observations: readonly TextObservation[], note?: string): AiCardSection {
  return note === undefined ? { id, title, items: observations.map(complete) } : { id, title, items: observations.map(complete), note };
}

function card(
  operation: AiSummaryOperation,
  headlineTitle: string,
  headline: TextObservation,
  sections: AiCardSection[],
  full: AiCardSection[],
  extra: Partial<Pick<AiSummaryCard, "chips" | "facts" | "limitations">> = {},
): AiSummaryCard {
  return { operation, headlineTitle, headline: concise(headline), sections, full, chips: extra.chips ?? [], facts: extra.facts ?? null, limitations: extra.limitations ?? [] };
}

const EVIDENCE_STATUS_WORDS: Record<AnalyzeSetupOutput["evidenceStatus"], string> = {
  NONE_SELECTED: "No screenshots were selected, so visual evidence was not reviewed.",
  SELECTED_NOT_INDEPENDENTLY_VERIFIED: "Selected screenshots were reviewed but not independently verified.",
};

export function summarizeAnalyzeSetup(output: AnalyzeSetupOutput): AiSummaryCard {
  const evidence = { text: EVIDENCE_STATUS_WORDS[output.evidenceStatus], sourceRefs: [] };
  return card("ANALYZE_SETUP", "Setup", output.setupStructure,
    [
      section("strengths", "Strengths", output.confluences),
      section("weaknesses", "Weaknesses", output.weaknesses),
      section("invalidation", "Invalidation", output.invalidation),
      section("observation", "AI observation", output.observations.slice(0, 1)),
      section("evidence", "Evidence", [evidence]),
    ],
    [
      fullSection("setup", "Setup", [output.setupStructure]),
      fullSection("entryModel", "Entry model", [output.entryModelAssessment]),
      fullSection("strengths", "Strengths", output.confluences),
      fullSection("weaknesses", "Weaknesses", output.weaknesses),
      fullSection("invalidation", "Invalidation", output.invalidation),
      fullSection("observations", "AI observations", output.observations),
      fullSection("evidence", "Evidence", [evidence]),
    ]);
}

export function summarizeBiasChallenge(output: BiasChallengeOutput): AiSummaryCard {
  return card("CHALLENGE_BIAS", "Why your thesis might be wrong", output.counterArgument,
    [
      section("invalidation", "Invalidation", output.invalidation),
      section("missingEvidence", "Missing evidence", output.missingEvidence),
      section("questions", "Questions to answer", output.questions),
    ],
    [
      fullSection("counterArgument", "Why your thesis might be wrong", [output.counterArgument]),
      fullSection("invalidation", "Invalidation", output.invalidation),
      fullSection("missingEvidence", "Missing evidence", output.missingEvidence),
      fullSection("questions", "Questions to answer", output.questions),
    ]);
}

const REVIEW_ASSESSMENT_LABELS: Record<string, string> = { ALIGNED: "Aligned", DEVIATION: "Deviation", INSUFFICIENT_EVIDENCE: "Insufficient evidence" };
const REVIEW_DIMENSIONS = [
  ["planAdherence", "Plan adherence"],
  ["executionQuality", "Execution quality"],
  ["modelFit", "Model fit"],
  ["processDiscipline", "Process discipline"],
  ["deviations", "Deviations"],
  ["behavioralMistakes", "Behavioral mistakes"],
] as const;

function asText(observation: AssessedObservation): TextObservation {
  return { text: observation.interpretation, sourceRefs: observation.sourceRefs };
}

/** Review Trade (V1): six dimension chips plus at most two lessons. */
export function summarizeTradeReview(output: TradeReviewOutput): AiSummaryCard {
  const chips = REVIEW_DIMENSIONS.map(([id, label]) => ({ id, label, assessment: output[id].assessment, assessmentLabel: REVIEW_ASSESSMENT_LABELS[output[id].assessment] ?? "Recorded" }));
  return card("REVIEW_TRADE", "Plan adherence", asText(output.planAdherence),
    [section("lessons", "Lessons", output.lessons.map(asText))],
    [...REVIEW_DIMENSIONS.map(([id, label]) => fullSection(id, label, [asText(output[id])])), fullSection("lessons", "Lessons", output.lessons.map(asText))],
    { chips, limitations: [...output.limitations] });
}

/** Output of the timeline-aware trade review (`REVIEW_TRADE_TIMELINE_V1`, spec §11.4). */
export interface TradeTimelineReviewOutput {
  headline: TextObservation;
  thesisCheck: { assessment: "CONSISTENT" | "CHANGED" | "NOT_RECORDED" | "INSUFFICIENT_EVIDENCE"; text: string; sourceRefs: readonly string[] };
  executionVsPlan: { assessment: "ALIGNED" | "DEVIATION" | "NO_PLAN" | "INSUFFICIENT_EVIDENCE"; text: string; sourceRefs: readonly string[] };
  liveManagement: { assessment: "DISCIPLINED" | "REACTIVE" | "NO_LIVE_RECORDS" | "INSUFFICIENT_EVIDENCE"; text: string; sourceRefs: readonly string[] };
  patterns: readonly TextObservation[];
  keyLesson: TextObservation;
  limitations: readonly string[];
}

const TIMELINE_ASSESSMENT_LABELS: Record<string, string> = {
  CONSISTENT: "Consistent", CHANGED: "Changed", NOT_RECORDED: "Not recorded", INSUFFICIENT_EVIDENCE: "Insufficient evidence",
  ALIGNED: "Aligned", DEVIATION: "Deviation", NO_PLAN: "No plan",
  DISCIPLINED: "Disciplined", REACTIVE: "Reactive", NO_LIVE_RECORDS: "No live records",
};

export function summarizeTradeTimelineReview(output: TradeTimelineReviewOutput): AiSummaryCard {
  const assessed = [["thesisCheck", "Thesis check"], ["executionVsPlan", "Execution vs plan"], ["liveManagement", "Live management"]] as const;
  const chips = assessed.map(([id, label]) => ({ id, label, assessment: output[id].assessment, assessmentLabel: TIMELINE_ASSESSMENT_LABELS[output[id].assessment] ?? "Recorded" }));
  return card("REVIEW_TRADE_TIMELINE", "Trade review", output.headline,
    [...assessed.map(([id, label]) => section(id, label, [output[id]])), section("keyLesson", "Key lesson", [output.keyLesson])],
    [
      fullSection("headline", "Trade review", [output.headline]),
      ...assessed.map(([id, label]) => fullSection(id, label, [output[id]])),
      fullSection("patterns", "Patterns", output.patterns),
      fullSection("keyLesson", "Key lesson", [output.keyLesson]),
    ],
    { chips, limitations: [...output.limitations] });
}

/** Deterministic facts from Trading OS shown on periodic cards. */
export interface PeriodicFacts {
  trades: number;
  netR: string | null;
}

function factsLine(facts: PeriodicFacts | undefined): string | null {
  if (!facts) return null;
  return facts.netR === null ? plural(facts.trades, "trade") : `${plural(facts.trades, "trade")} · ${formatR(facts.netR)}`;
}

function periodic(
  operation: AiSummaryOperation,
  headline: TextObservation,
  wentWell: readonly TextObservation[],
  attention: readonly TextObservation[],
  focus: readonly TextObservation[],
  full: AiCardSection[],
  facts: PeriodicFacts | undefined,
): AiSummaryCard {
  return card(operation, "Summary", headline,
    [section("wentWell", "Went well", wentWell), section("needsAttention", "Needs attention", attention), section("focusNext", "Focus next", focus)],
    full, { facts: factsLine(facts) });
}

export function summarizeWeeklyReview(output: WeeklyReviewOutput, facts?: PeriodicFacts): AiSummaryCard {
  return periodic("WEEKLY_REVIEW", output.weekSummary, output.whatImproved, output.needsAttention, output.focusNextWeek, [
    fullSection("summary", "Summary", [output.weekSummary]),
    fullSection("processQuality", "Process quality", output.processQuality),
    fullSection("ruleAdherence", "Rule adherence", output.ruleAdherence),
    fullSection("setupModelPatterns", "Setup and model patterns", output.setupModelPatterns),
    fullSection("executionMistakes", "Execution mistakes", output.executionMistakes),
    fullSection("behavioralPatterns", "Behavioral patterns", output.behavioralPatterns),
    fullSection("whatImproved", "What improved", output.whatImproved),
    fullSection("needsAttention", "Needs attention", output.needsAttention),
    fullSection("focusNext", "Focus next week", output.focusNextWeek),
  ], facts);
}

/** Recent trades has no summary field; its process-discipline finding leads the card. */
export function summarizeRecentTrades(output: RecentTradesOutput, facts?: PeriodicFacts): AiSummaryCard {
  return periodic("RECENT_TRADES_ANALYSIS", output.processDiscipline[0], output.strengths, output.executionMistakes, output.monitorNext, [
    fullSection("strengths", "Recurring strengths", output.strengths),
    fullSection("executionMistakes", "Recurring execution mistakes", output.executionMistakes),
    fullSection("entryModelPatterns", "Entry model patterns", output.entryModelPatterns),
    fullSection("sessionPatterns", "Session patterns", output.sessionPatterns),
    fullSection("processDiscipline", "Risk and process discipline", output.processDiscipline),
    fullSection("behavioralPatterns", "Behavioral patterns", output.behavioralPatterns),
    fullSection("outliers", "Outliers", output.outliers),
    fullSection("monitorNext", "What to monitor next", output.monitorNext),
  ], facts);
}

export function summarizeMonthlyReview(output: MonthlyReviewOutput, facts?: PeriodicFacts): AiSummaryCard {
  return periodic("MONTHLY_REVIEW", output.monthSummary, output.recurringStrengths, output.recurringMistakes, output.focusNextMonth, [
    fullSection("summary", "Summary", [output.monthSummary]),
    fullSection("processQuality", "Process quality", output.processQuality),
    fullSection("ruleAdherence", "Rule adherence", output.ruleAdherence),
    fullSection("entryModelPatterns", "Entry model patterns", output.entryModelPatterns),
    fullSection("sessionPatterns", "Session patterns", output.sessionPatterns),
    fullSection("executionQuality", "Execution quality", output.executionQuality),
    fullSection("behavioralPatterns", "Behavioral patterns", output.behavioralPatterns),
    fullSection("recurringStrengths", "Recurring strengths", output.recurringStrengths),
    fullSection("recurringMistakes", "Recurring mistakes", output.recurringMistakes),
    fullSection("whatImproved", "What improved", output.whatImproved, CHANGE_EVIDENCE_NOTE),
    fullSection("whatDegraded", "What degraded", output.whatDegraded, CHANGE_EVIDENCE_NOTE),
    fullSection("keyLessons", "Key lessons", output.keyLessons),
    fullSection("focusNext", "Focus next month", output.focusNextMonth),
  ], facts);
}

// ---------------------------------------------------------------------------------------------
// Source chips
// ---------------------------------------------------------------------------------------------

export type SourceChipKind =
  | "plan" | "thesis" | "strategy" | "risk-engine" | "risk-plan" | "execution" | "tags" | "evidence" | "note" | "event"
  | "trade" | "period" | "sample" | "metrics" | "unknown";

export interface SourceChip {
  label: string;
  kind: SourceChipKind;
  /** Link target: the trade page, or an in-page anchor for timeline items and evidence. */
  href?: string;
  evidenceId?: string;
  /** Raw canonical id; only for the collapsed Technical details. */
  technicalId: string;
}

/** Display metadata for evidence ids (`evidence:<id>`), keyed by evidence id. */
export type EvidenceIndex = Readonly<Record<string, { label?: string | null; timeframe?: string | null }>>;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Follows a manifest path such as `trades[2].events[1]` or `breakdowns.sessions`. */
function atPath(facts: unknown, path: string): unknown {
  let node: unknown = facts;
  for (const segment of path.match(/[^.[\]]+/g) ?? []) {
    if (Array.isArray(node) && /^\d+$/.test(segment)) node = node[Number(segment)];
    else if (isRecord(node) && Object.hasOwn(node, segment)) node = node[segment];
    else return undefined;
  }
  return node;
}

function manifestPath(manifest: unknown, sourceId: string): string | null {
  const sources = isRecord(manifest) && Array.isArray(manifest.sources) ? manifest.sources : [];
  const entry = sources.find(source => isRecord(source) && source.id === sourceId);
  return isRecord(entry) ? str(entry.path) : null;
}

function findById(list: unknown, key: string, id: string): Json | null {
  return Array.isArray(list) ? (list.find(item => isRecord(item) && item[key] === id) as Json | undefined) ?? null : null;
}

const TIMEFRAMES = new Set(["DAILY", "H4", "H1", "M30", "M15", "M5", "M3"]);
const TIMEFRAME_NAMES: Record<string, string> = { DAILY: "Daily", H4: "H4", H1: "H1", M30: "M30", M15: "M15", M5: "M5", M3: "M3" };
const EVIDENCE_LABEL_NAMES: Record<string, string> = {
  HTF: "HTF screenshot", CONTEXT: "Context screenshot", PRE_ENTRY: "Pre-entry screenshot", ENTRY: "Entry screenshot",
  MANAGEMENT: "Management screenshot", EXIT: "Exit screenshot", OTHER: "Screenshot",
};

function evidenceChipLabel(label: string | null, timeframe: string | null): string {
  if (timeframe && TIMEFRAMES.has(timeframe)) return `${TIMEFRAME_NAMES[timeframe]} chart`;
  if (label && TIMEFRAMES.has(label)) return `${TIMEFRAME_NAMES[label]} chart`;
  if (label && Object.hasOwn(EVIDENCE_LABEL_NAMES, label)) return EVIDENCE_LABEL_NAMES[label];
  return "Chart";
}

const NOTE_TIMING_WORDS: Record<string, string> = { BEFORE_ENTRY: "Pre-entry note", WHILE_LIVE: "Live note", AFTER_CLOSE: "After-close note" };
/** V1 event and decision types, worded as the trade timeline titles them (src/domain/timeline.ts). */
const EVENT_WORDS: Record<string, string> = {
  TRADE_OPENED: "Entry", TRADE_CLOSED: "Exit", PLAN_LOCKED: "Plan lock", PLAN_CANCELLED: "Plan cancelled", STOP_MOVED: "Stop moved",
  TARGET_CHANGED: "Target changed", PARTIAL_CLOSED: "Partial close", SL_TO_BE: "Stop moved to break-even", POSITION_ADDED: "Position added",
  HUMAN_DECISION: "Decision", MANUAL_OVERRIDE: "Taken despite a block",
};
/** V1 events the trade timeline shows as its plan lock, entry and close items, never as an item of their own. */
const TIMELINE_REPRESENTED_EVENTS = new Set(["PLAN_LOCKED", "TRADE_OPENED", "TRADE_CLOSED"]);
const V1_PERIODIC_FACTS = new Set(["WEEKLY_REVIEW_FACTS_V1", "RECENT_TRADES_FACTS_V1", "MONTHLY_REVIEW_FACTS_V1"]);

function recordFor(sourceId: string, facts: unknown, manifest: unknown): Json | null {
  const path = manifestPath(manifest, sourceId);
  const resolved = path ? atPath(facts, path) : undefined;
  return isRecord(resolved) ? resolved : null;
}

/** `09:45` in the display, or null for a missing or unreadable time. */
function timeText(at: string | null, display: TimeDisplay): string | null {
  if (at === null) return null;
  try {
    return formatTime(at, display);
  } catch {
    return null;
  }
}

function timelineRecord(sourceId: string, facts: unknown, manifest: unknown): Json | null {
  return recordFor(sourceId, facts, manifest) ?? (isRecord(facts) ? findById(facts.timeline, "sourceId", sourceId) : null);
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A journal entry or event of a periodic snapshot as a record: V2 periodic facts write a journal entry as the row
 * `[id, kind, recordedAt, timing, text, extra]` (src/ai/periodic-facts.ts); events and earlier facts use objects.
 */
function periodicEntry(entry: unknown): Json | null {
  if (isRecord(entry)) return entry;
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
  const [id, kind, recordedAt, timing] = entry;
  return { id, kind, recordedAt, timing };
}

/**
 * The included trade of a periodic snapshot (`facts.trades[i]`) that holds the cited journal entry (`journal:<id>`) or
 * event (`event:<id>`), with the record: through the manifest path when the facts were stored with one, otherwise by id.
 * Null for facts without trades (the trade reviews, whose records are on the page).
 */
function periodicRecord(sourceId: string, uuid: string, facts: unknown, manifest: unknown): { trade: Json; record: Json } | null {
  if (!isRecord(facts) || !Array.isArray(facts.trades)) return null;
  const list = sourceId.startsWith("journal:") ? "journal" : "events";
  const path = /^trades\[(\d+)\]\.(events|journal)\[(\d+)\]$/.exec(manifestPath(manifest, sourceId) ?? "");
  if (path && path[2] === list) {
    const trade = facts.trades[Number(path[1])];
    const record = isRecord(trade) && Array.isArray(trade[list]) ? periodicEntry(trade[list][Number(path[3])]) : null;
    if (isRecord(trade) && record?.id === uuid) return { trade, record };
  }
  for (const trade of facts.trades) {
    if (!isRecord(trade) || !Array.isArray(trade[list])) continue;
    const record = trade[list].map(periodicEntry).find(entry => entry?.id === uuid);
    if (record) return { trade, record };
  }
  return null;
}

/**
 * Where a periodic record opens: its trade's timeline item, `/trades/<trade>#journal:<id>` (V2 facts name the trade by
 * `tradeRecordId`), or, for V1 facts that only know the plan, `/journal/<plan>#event:<id>`, which redirects to the trade.
 * A V1 plan lock, entry or close event has no timeline item of its own (`TIMELINE_REPRESENTED_EVENTS`): it opens the
 * trade. Ids that are not UUIDs never become links.
 */
function periodicRecordHref(sourceId: string, trade: Json, record: Json): string | undefined {
  const anchor = TIMELINE_REPRESENTED_EVENTS.has(str(record.event_type) ?? "") ? "" : `#${sourceId}`;
  const tradeRecordId = str(trade.tradeRecordId);
  if (tradeRecordId && UUID_TEXT.test(tradeRecordId)) return `/trades/${tradeRecordId}${anchor}`;
  const planId = str(trade.tradeId);
  return planId && UUID_TEXT.test(planId) ? `/journal/${planId}${anchor}` : undefined;
}

/** Facts of a periodic review (weekly, recent trades, monthly): their records belong to the trades they list. */
function isPeriodicFacts(facts: unknown): boolean {
  return isRecord(facts) && Array.isArray(facts.trades);
}

function noteChip(sourceId: string, uuid: string, facts: unknown, manifest: unknown, display: TimeDisplay): SourceChip {
  const periodic = periodicRecord(sourceId, uuid, facts, manifest);
  const record = periodic?.record ?? timelineRecord(sourceId, facts, manifest) ?? (isRecord(facts) ? findById(facts.events, "id", uuid) : null);
  const time = timeText(str(record?.occurredAt) ?? str(record?.recordedAt) ?? str(record?.occurred_at) ?? str(record?.recorded_at), display);
  const timing = str(record?.timing);
  const eventType = str(record?.event_type) ?? str(record?.kind);
  const isNote = !eventType || eventType === "NOTE_ADDED" || eventType === "NOTE" || sourceId.startsWith("journal:") || sourceId.startsWith("note:");
  const word = isNote
    ? (timing && Object.hasOwn(NOTE_TIMING_WORDS, timing) ? NOTE_TIMING_WORDS[timing] : "Journal note")
    : (eventType && Object.hasOwn(EVENT_WORDS, eventType) ? EVENT_WORDS[eventType] : "Trade event");
  const kind = isNote ? "note" : "event";
  const own = time ? `${word} · ${time}` : word;
  // A periodic review lists many trades and has no timeline of its own: the chip names the trade and opens its timeline.
  if (periodic) {
    const trade = tradeLabel(periodic.trade, display);
    const href = periodicRecordHref(sourceId, periodic.trade, periodic.record);
    const label = trade ? `${trade} · ${own}` : own;
    return href ? { label, kind, href, technicalId: sourceId } : { label, kind, technicalId: sourceId };
  }
  // A periodic record the facts do not hold has no page to open: an anchor on the review page would lead nowhere.
  if (isPeriodicFacts(facts)) return { label: own, kind, technicalId: sourceId };
  return { label: own, kind, href: `#${sourceId}`, technicalId: sourceId };
}

/** Timeline records cited by the timeline-aware trade review (`REVIEW_TRADE_TIMELINE_FACTS_V1`, spec §11.4). */
const TIMELINE_RECORD_WORDS = {
  revision: "Draft revision", check: "Risk check", plan: "Plan lock", execution: "Entry", position: "Entry details", close: "Exit",
} as const;
type TimelineRecordPrefix = keyof typeof TIMELINE_RECORD_WORDS;

function isTimelineRecordPrefix(prefix: string): prefix is TimelineRecordPrefix {
  return Object.hasOwn(TIMELINE_RECORD_WORDS, prefix);
}

/**
 * `Draft revision 2 · 07:00`, `Risk check · 07:05`, `Plan lock · 07:10`, `Entry · 07:15`, `Exit · 09:55`
 * (strategy time by default), linking to the trade timeline item (`TimelineItem.id`); the execution
 * and every position facts row are rendered by the trade's one entry item. Null when the facts do not
 * contain the record.
 */
function timelineRecordChip(sourceId: string, prefix: TimelineRecordPrefix, uuid: string, facts: unknown, manifest: unknown, display: TimeDisplay): SourceChip | null {
  const record = timelineRecord(sourceId, facts, manifest);
  if (record === null) return null;
  const details = isRecord(record.details) ? record.details : {};
  const word = prefix === "revision" && typeof details.revision === "number" ? `Draft revision ${details.revision}` : TIMELINE_RECORD_WORDS[prefix];
  const time = timeText(str(record.occurredAt) ?? str(record.recordedAt), display);
  const tradeId = isRecord(facts) ? str(facts.tradeId) : null;
  const anchor = prefix === "execution" ? `entry:${uuid}` : prefix === "position" && tradeId ? `entry:${tradeId}` : sourceId;
  return { label: time ? `${word} · ${time}` : word, kind: "event", href: `#${anchor}`, technicalId: sourceId };
}

/** `EURUSD long · Oct 14` (instrument, direction and exit day of a periodic trade record), or null when unreadable. */
function tradeLabel(record: Json | null, display: TimeDisplay): string | null {
  const plan = isRecord(record?.originalPlan) ? record.originalPlan : null;
  const proposal = isRecord(plan?.proposal) ? plan.proposal : null;
  const execution = isRecord(record?.execution) ? record.execution : null;
  const instrument = str(plan?.instrument);
  const direction = str(proposal?.direction)?.toLowerCase() ?? null;
  const exited = str(execution?.exited_at);
  let day: string | null = null;
  try {
    day = exited ? formatDay(exited, display) : null;
  } catch {
    day = null;
  }
  const name = [instrument, direction].filter(Boolean).join(" ");
  return name ? (day ? `${name} · ${day}` : name) : null;
}

function tradeChip(sourceId: string, uuid: string, facts: unknown, manifest: unknown, display: TimeDisplay): SourceChip {
  // V1 facts cite a trade by its plan id (`tradeId`); V2 periodic facts by the trade's own id (`tradeRecordId`).
  const record = recordFor(sourceId, facts, manifest) ?? (isRecord(facts) ? findById(facts.trades, "tradeId", uuid) ?? findById(facts.trades, "tradeRecordId", uuid) : null);
  const label = tradeLabel(record, display) ?? "Trade";
  const legacyIds = isRecord(facts) && typeof facts.version === "string" && V1_PERIODIC_FACTS.has(facts.version);
  return { label, kind: "trade", href: legacyIds ? `/journal/${uuid}` : `/trades/${uuid}`, technicalId: sourceId };
}

function versionChip(sourceId: string, uuid: string, facts: unknown, manifest: unknown, kind: "strategy" | "risk-plan"): SourceChip {
  const listKey = kind === "strategy" ? "strategyVersions" : "riskVersions";
  const record = recordFor(sourceId, facts, manifest) ?? (isRecord(facts) ? findById(facts[listKey], "id", uuid) : null);
  const version = str(record?.version);
  const label = kind === "strategy" ? (version ? `Strategy ${version}` : "Strategy") : version ?? "Risk Plan";
  return { label, kind, technicalId: sourceId };
}

function periodChip(facts: unknown): string {
  const period = isRecord(facts) && isRecord(facts.period) ? facts.period : null;
  const month = str(period?.month);
  const start = str(period?.startDate);
  try {
    if (month) return formatMonth(month);
    if (start) return `Week of ${formatDay(start)}`;
  } catch {
    return "Period";
  }
  return "Period";
}

function sampleChip(facts: unknown): string {
  const sample = isRecord(facts) && isRecord(facts.sample) ? facts.sample : null;
  const count = typeof sample?.count === "number" ? sample.count : typeof sample?.actual === "number" ? sample.actual : Array.isArray(sample?.tradeIds) ? sample.tradeIds.length : null;
  return count === null ? "Sample" : `Sample · ${plural(count, "trade")}`;
}

/**
 * Friendly chip for a canonical citation id (spec §11.1). Timeline records of the trade review
 * (`revision:`, `check:`, `plan:`, `execution:`, `position:`, `close:`) and notes resolve against the
 * facts' timeline. Unknown or legacy ids, and records missing from the facts, fall back to a neutral
 * "Source" chip; the raw id is only exposed as `technicalId`.
 */
export function resolveSourceChip(sourceId: string, facts: unknown, manifest?: unknown, evidenceIndex: EvidenceIndex = {}, display: TimeDisplay = STRATEGY_TIME): SourceChip {
  const factsRecord = isRecord(facts) ? facts : {};
  const chip = (label: string, kind: SourceChipKind): SourceChip => ({ label, kind, technicalId: sourceId });
  switch (sourceId) {
    case "proposal":
    case "originalPlan": return chip("Trade plan", "plan");
    case "currentThesis": return chip("Your thesis", "thesis");
    case "strategy": {
      const version = isRecord(factsRecord.strategy) ? str(factsRecord.strategy.version) : null;
      return chip(version ? `Strategy ${version}` : "Strategy", "strategy");
    }
    case "deterministic": return chip("Risk Engine", "risk-engine");
    case "riskVersion": {
      const version = isRecord(factsRecord.riskVersion) ? str(factsRecord.riskVersion.version) : null;
      return chip(version ?? "Risk Plan", "risk-plan");
    }
    case "execution": return chip("Execution", "execution");
    case "tags": return chip("Your tags", "tags");
    case "period": return chip(periodChip(facts), "period");
    case "sample": return chip(sampleChip(facts), "sample");
    case "edge": return chip("EDGE metrics", "metrics");
    case "models": return chip("By model", "metrics");
    case "sessions": return chip("By session", "metrics");
  }
  const separator = sourceId.indexOf(":");
  const prefix = separator > 0 ? sourceId.slice(0, separator) : "";
  const uuid = separator > 0 ? sourceId.slice(separator + 1) : "";
  if (!uuid) return chip("Source", "unknown");
  if (isTimelineRecordPrefix(prefix)) return timelineRecordChip(sourceId, prefix, uuid, facts, manifest, display) ?? chip("Source", "unknown");
  switch (prefix) {
    case "evidence": {
      const indexed = Object.hasOwn(evidenceIndex, uuid) ? evidenceIndex[uuid] : null;
      const record = recordFor(sourceId, facts, manifest) ?? findById(factsRecord.selectedEvidence, "id", uuid) ?? findById(factsRecord.evidence, "id", uuid);
      const label = str(indexed?.label) ?? str(record?.label) ?? str(record?.role);
      const timeframe = str(indexed?.timeframe) ?? str(record?.timeframe);
      return { label: evidenceChipLabel(label, timeframe), kind: "evidence", href: `#evidence-${uuid}`, evidenceId: uuid, technicalId: sourceId };
    }
    case "event":
    case "journal":
    case "note": return noteChip(sourceId, uuid, facts, manifest, display);
    case "trade": return tradeChip(sourceId, uuid, facts, manifest, display);
    case "strategy": return versionChip(sourceId, uuid, facts, manifest, "strategy");
    case "risk": return versionChip(sourceId, uuid, facts, manifest, "risk-plan");
    default: return chip("Source", "unknown");
  }
}

// ---------------------------------------------------------------------------------------------
// Cost estimates
// ---------------------------------------------------------------------------------------------

/**
 * Typical cost per operation in micro-euros, from measured staging runs (spec §11.2).
 * REVIEW_TRADE_TIMELINE uses REVIEW_TRADE's figure until it is measured.
 */
export const AI_TYPICAL_COST_MICROS = Object.freeze({
  REVIEW_TRADE: 16_000,
  CHALLENGE_BIAS: 15_800,
  ANALYZE_SETUP: 18_500,
  WEEKLY_REVIEW: 21_300,
  RECENT_TRADES_ANALYSIS: 28_900,
  MONTHLY_REVIEW: 34_400,
  REVIEW_TRADE_TIMELINE: 16_000,
});
export type AiCostOperation = keyof typeof AI_TYPICAL_COST_MICROS;

export interface AiCostEstimate {
  typicalMicros: number;
  /** The reservation actually held for the request (`reservationMicros`), released when unused. */
  maxMicros: number;
}

/**
 * Typical and maximum cost of one request. `now` decides pricing validity: an expired or
 * unknown pricing profile throws ("AI pricing requires review…"), as the request gate would.
 */
export function estimateAiCost(operation: AiCostOperation, now: Date): AiCostEstimate {
  const definition = operationFor(operation);
  return { typicalMicros: AI_TYPICAL_COST_MICROS[operation], maxMicros: reservationMicros(operationPricing(definition, now), definition) };
}
