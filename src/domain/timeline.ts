import { aiOperationLabel, aiStatusLabel } from "./ai-summary";
import { formatPrice, formatQuantity, formatR, formatSignedMoney, stripZeros } from "./format";
import type { LedgerTrade, TradeOrigin } from "./ledger";
import { type ExplainLookup, explainReport } from "./risk-explain";
import { type StoredRiskReport, storedRiskSchema } from "./risk-report";
import { compareInstants, differsByMoreThan, displayDay, formatDateTime, formatTime, type Instant, STRATEGY_TIME, type TimeDisplay } from "./time-display";

/**
 * Effective timing of trade records (spec §5.3) and the trade timeline (spec §5.4).
 * Only BEFORE_ENTRY items may be presented as pre-entry evidence. The stored phase can never
 * upgrade an item to BEFORE_ENTRY; timestamps can only downgrade it.
 */

export type Timing = "BEFORE_ENTRY" | "WHILE_LIVE" | "AFTER_CLOSE";
export type StoredPhase = "PRE_ENTRY" | "LIVE" | "POST_TRADE";
/**
 * `RECORDED_AFTER_EXECUTION_BEGAN`: stored before entry but recorded at or after the reported entry time.
 * `RECORDED_AFTER_PLAN_ENDED`: stored as if the plan were still open, but recorded at or after the skip, the
 * cancellation or the discard that ended it (rows written before the database stored such records post-trade).
 */
export type TimingFlag = "RECORDED_AFTER_EXECUTION_BEGAN" | "RECORDED_AFTER_PLAN_ENDED";

export const TIMING_ORDER: readonly Timing[] = Object.freeze(["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"]);
export const TIMING_LABELS: Readonly<Record<Timing, string>> = Object.freeze({ BEFORE_ENTRY: "Before entry", WHILE_LIVE: "While live", AFTER_CLOSE: "After close" });
export const TIMING_FLAG_COPY: Readonly<Record<TimingFlag, string>> = Object.freeze({
  RECORDED_AFTER_EXECUTION_BEGAN: "Recorded after execution began",
  RECORDED_AFTER_PLAN_ENDED: "Recorded after the plan ended",
});

export interface TimingInput {
  recordedAt: Instant;
  storedPhase: StoredPhase;
  origin: TradeOrigin;
  /** User-reported entry time; null when unknown or not entered. */
  entryAt: Instant | null;
  /** Server time the entry was recorded (used to infer the phase of records without one). */
  entryRecordedAt?: Instant | null;
  /** User-reported exit time; null while open. */
  exitAt: Instant | null;
  /** `trades.created_at`: the entry time of a live-first/imported trade whose entry time is unknown. */
  tradeCreatedAt?: Instant | null;
  /**
   * When a planned trade ended without an entry (`planEndedAt`, `private.plan_ended_at`): the skip or cancellation
   * of its plan, or the discard of the draft. Null for every other trade.
   */
  endedAt?: Instant | null;
}

export interface TimingResult {
  timing: Timing;
  flags: TimingFlag[];
}

/**
 * `classifyTiming` as spec §5.3, with microsecond-exact instant comparison. A record made at or after the end of a
 * plan that never had an entry is hindsight, like one made after a close: After close, whatever phase it stored
 * (the database stores such records post-trade; an older row that says otherwise is marked).
 */
export function classifyTiming(input: TimingInput): TimingResult {
  if (input.exitAt !== null && compareInstants(input.recordedAt, input.exitAt) >= 0) return { timing: "AFTER_CLOSE", flags: [] };
  if (input.endedAt != null && compareInstants(input.recordedAt, input.endedAt) >= 0) {
    return { timing: "AFTER_CLOSE", flags: input.storedPhase === "POST_TRADE" ? [] : ["RECORDED_AFTER_PLAN_ENDED"] };
  }
  if (input.storedPhase === "POST_TRADE") return { timing: "AFTER_CLOSE", flags: [] };
  if (input.storedPhase === "PRE_ENTRY") {
    const entryAt = input.entryAt ?? (input.origin === "PLANNED" ? null : input.tradeCreatedAt ?? null);
    if (entryAt !== null && compareInstants(input.recordedAt, entryAt) >= 0) return { timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] };
    // Live-first and imported trades are open from creation: never BEFORE_ENTRY.
    return input.origin === "PLANNED" ? { timing: "BEFORE_ENTRY", flags: [] } : { timing: "WHILE_LIVE", flags: [] };
  }
  return { timing: "WHILE_LIVE", flags: [] };
}

/**
 * Phase a record would have been stored with at creation (`private.trade_phase`), for records
 * that predate stored phases (V1 notes, legacy screenshots, checks): compares server times only.
 * `endedAt`: when a planned trade ended without an entry (`planEndedAt`); records from then on are post-trade.
 */
export function inferStoredPhase(
  recordedAt: Instant, entryRecordedAt: Instant | null | undefined, closeRecordedAt: Instant | null | undefined, endedAt?: Instant | null,
): StoredPhase {
  if (closeRecordedAt != null && compareInstants(recordedAt, closeRecordedAt) >= 0) return "POST_TRADE";
  if (entryRecordedAt != null && compareInstants(recordedAt, entryRecordedAt) >= 0) return "LIVE";
  if (endedAt != null && compareInstants(recordedAt, endedAt) >= 0) return "POST_TRADE";
  return "PRE_ENTRY";
}

export type JournalKind = "NOTE" | "DECISION" | "STOP_CHANGE" | "TARGET_CHANGE" | "PARTIAL_CLOSE" | "LESSON";
export type EvidenceLabel = "HTF" | "CONTEXT" | "PRE_ENTRY" | "ENTRY" | "MANAGEMENT" | "EXIT" | "OTHER";
export type TimelineKind =
  | "DRAFT_REVISION" | "RISK_CHECK" | "PLAN_LOCKED" | "NOTE" | "TRADE_EVENT" | "ENTRY" | "SIZE_DEVIATION" | "JOURNAL"
  | "EVIDENCE_ADDED" | "EVIDENCE_REMOVED" | "TAGS" | "DISPOSITION" | "CLOSE" | "AI_ANALYSIS"
  | "REVIEW_COMPLETED" | "REVIEW_REOPENED" | "DRAFT_DISCARDED";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  /** Real time of the event: user-reported entry/exit times, otherwise the server recording time. */
  at: string;
  recordedAt: string;
  timing: Timing;
  flags: TimingFlag[];
  title: string;
  body?: string;
  details?: Record<string, unknown>;
  journalKind?: JournalKind;
  evidenceId?: string;
  /** Canonical reference of the underlying record (`journal:<id>`, `event:<id>`, `evidence:<id>`, …). */
  source: string;
  /** `09:42`, or `09:42 · recorded 10:15` when the two times differ by more than five minutes. */
  timeLabel: string;
}

export type TimelineTrade = Pick<LedgerTrade,
  | "id" | "origin" | "created_at" | "currency" | "plan_id" | "locked_at" | "strategy_version" | "risk_plan_version"
  | "entered_at" | "entry_recorded_at" | "entry_price" | "quantity" | "planned_quantity" | "oversize"
  | "exited_at" | "close_recorded_at" | "exit_price" | "realized_r" | "net_pnl">;

export interface TimelineRevision { proposalId: string; revision: number; createdAt: string }
export interface TimelineRiskCheck {
  id: string;
  recordedAt: string;
  decision: "APPROVED" | "BLOCKED";
  result?: unknown;
  /** Proposal (draft revision) the check evaluated. */
  proposalId?: string;
}

/**
 * Immutable rows that explain one stored check (spec §6.5): the risk plan version named by
 * `report.riskPlanVersionId`, the report's instrument version and the checked proposal. Checks of one
 * trade can run under different risk plan versions, so rows are resolved per check; undefined (no
 * matching rows) falls back to the generic sentence. Rows that carry their `id` are additionally
 * checked against the report (`ExplainLookup`).
 */
export type CheckExplainLookup = (check: TimelineRiskCheck, report: StoredRiskReport) => ExplainLookup | undefined;

export interface TimelineLegacyEvent { id: string; eventType: string; payload: Record<string, unknown>; occurredAt: string; recordedAt: string }
export interface TimelineJournalEntry { id: string; kind: JournalKind; body: string | null; details: Record<string, unknown>; phase: StoredPhase; recordedAt: string }
export type TimelineEvidence =
  | { kind: "V2"; id: string; label: EvidenceLabel; timeframe: string | null; caption?: string | null; phase: StoredPhase; recordedAt: string; removedAt?: string | null }
  | { kind: "LEGACY"; id: string; role: string; recordedAt: string; removedAt?: string | null };
export interface TimelineTagSet { id: string; source: "V2" | "V1"; recordedAt: string; setupGrade: string | null; liquidityContext: string | null; mssTimeframe: string | null; tags?: readonly string[] }
export interface TimelineDisposition { status: "SKIPPED" | "CANCELLED"; reason: string | null; recordedAt: string }
export interface TimelineAiAnalysis { id: string; operation: string; status: string; recordedAt: string; summary?: string | null }
export interface TimelineLifecycleEvent { id: string; event: "DRAFT_DISCARDED" | "REVIEW_COMPLETED" | "REVIEW_REOPENED"; reason: string | null; recordedAt: string }

export interface TimelineInputs {
  trade: TimelineTrade;
  instrument?: { tickSize?: string | null; quantityStep?: string | null; quantityUnit?: string | null } | null;
  revisions?: readonly TimelineRevision[];
  riskChecks?: readonly TimelineRiskCheck[];
  /** V1 `trade_events` of the linked plan. */
  legacyEvents?: readonly TimelineLegacyEvent[];
  journal?: readonly TimelineJournalEntry[];
  evidence?: readonly TimelineEvidence[];
  tagSets?: readonly TimelineTagSet[];
  disposition?: TimelineDisposition | null;
  aiAnalyses?: readonly TimelineAiAnalysis[];
  lifecycleEvents?: readonly TimelineLifecycleEvent[];
  /**
   * When the planned trade ended without an entry (`planEndedAt`): the skip or cancellation of its plan, the discard
   * of the draft, or a V1 skip. Everything recorded from then on is After close; the record that ended it is not.
   */
  planEndedAt?: string | null;
  /** The risk evaluation that authorised the lock (`trade_plans.risk_evaluation_id`): shown with the lock, before it. */
  lockEvaluationId?: string | null;
  /** Rows to explain the first blocking reason of 1.1 and legacy risk checks, resolved per check. */
  explainLookup?: CheckExplainLookup;
}

const LEGACY_HTF_ROLES = new Set(["DAILY", "H4", "H1"]);
/** Legacy screenshots carry a timeframe role only (spec §7.5). */
export function legacyEvidenceLabel(role: string): EvidenceLabel {
  return LEGACY_HTF_ROLES.has(role) ? "HTF" : "OTHER";
}

const TIMEFRAME_LABELS: Record<string, string> = { DAILY: "Daily", H4: "H4", H1: "H1", M30: "M30", M15: "M15", M5: "M5", M3: "M3" };
const LABEL_WORDS: Record<EvidenceLabel, string> = {
  HTF: "HTF screenshot", CONTEXT: "Context screenshot", PRE_ENTRY: "Pre-entry screenshot", ENTRY: "Entry screenshot",
  MANAGEMENT: "Management screenshot", EXIT: "Exit screenshot", OTHER: "Screenshot",
};

/** `M5 chart`, `Daily chart`, `Entry screenshot` (timeframe first, then the label). */
export function evidenceName(label: EvidenceLabel | null, timeframe: string | null): string {
  if (timeframe && Object.hasOwn(TIMEFRAME_LABELS, timeframe)) return `${TIMEFRAME_LABELS[timeframe]} chart`;
  return label ? LABEL_WORDS[label] : "Screenshot";
}

const LIQUIDITY_LABELS: Record<string, string> = {
  ARL_HIGH: "Asian range high", ARL_LOW: "Asian range low", PDH: "PDH", PDL: "PDL", PWH: "PWH", PWL: "PWL",
  KZ_HIGH: "Kill zone high", KZ_LOW: "Kill zone low", EQUAL_HIGHS: "Equal highs", EQUAL_LOWS: "Equal lows", OTHER: "Other liquidity",
};

const LEGACY_EVENT_TITLES: Record<string, string> = {
  STOP_MOVED: "Stop moved", TARGET_CHANGED: "Target changed", PARTIAL_CLOSED: "Partial close", SL_TO_BE: "Stop moved to break-even",
  POSITION_ADDED: "Position added", MANUAL_OVERRIDE: "Taken despite a block", TRADE_OPENED: "Trade opened", TRADE_CLOSED: "Trade closed",
  PLAN_LOCKED: "Plan locked", PLAN_CANCELLED: "Plan cancelled",
};

const FIVE_MINUTES = 5;

function timeLabel(at: string, recordedAt: string, display: TimeDisplay): string {
  const main = formatTime(at, display);
  if (!differsByMoreThan(at, recordedAt, FIVE_MINUTES)) return main;
  const sameDay = displayDay(at, display) === displayDay(recordedAt, display);
  return `${main} · recorded ${sameDay ? formatTime(recordedAt, display) : formatDateTime(recordedAt, display)}`;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function quantityUnit(inputs: TimelineInputs): string {
  const unit = inputs.instrument?.quantityUnit?.trim();
  return unit ? ` ${unit.split(" (")[0]}` : "";
}

function isLegacyTagNote(event: TimelineLegacyEvent): boolean {
  const payload = event.payload;
  return payload.source === "MANUAL" && ("setup_grade" in payload || "liquidity_context" in payload || "mss_timeframe" in payload);
}

function tagSummary(set: TimelineTagSet): string {
  const parts = [
    set.setupGrade ? `Grade ${set.setupGrade}` : null,
    set.liquidityContext ? LIQUIDITY_LABELS[set.liquidityContext] ?? set.liquidityContext : null,
    set.mssTimeframe ? `MSS ${set.mssTimeframe}` : null,
    set.tags?.length ? set.tags.join(", ") : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : "Tags cleared";
}

function journalTitle(entry: TimelineJournalEntry, inputs: TimelineInputs): string {
  const tick = inputs.instrument?.tickSize ?? null;
  const step = inputs.instrument?.quantityStep ?? null;
  const price = textOf(entry.details.price);
  switch (entry.kind) {
    case "NOTE": return "Note";
    case "DECISION": return "Decision";
    case "LESSON": return "Lesson";
    case "STOP_CHANGE": return price ? `Stop moved to ${formatPrice(price, tick)}` : "Stop moved";
    case "TARGET_CHANGE": return price ? `Target moved to ${formatPrice(price, tick)}` : "Target moved";
    case "PARTIAL_CLOSE": {
      const percent = textOf(entry.details.percent);
      const quantity = textOf(entry.details.quantity);
      const size = percent ? ` · ${stripZeros(percent)}%` : quantity ? ` · ${formatQuantity(quantity, step)}${quantityUnit(inputs)}` : "";
      return `Partial close${size}${price ? ` at ${formatPrice(price, tick)}` : ""}`;
    }
  }
}

function aiTitle(analysis: TimelineAiAnalysis): string {
  return `${aiOperationLabel(analysis.operation)} · ${aiStatusLabel(analysis.status)}`;
}

/** Where an item sits in the history: at `orderAt` (default `at`), then by `rank` among items of the same instant. */
interface Placement {
  orderAt?: string;
  rank?: number;
}

/**
 * Assembles every timeline source into items sorted by (at, recordedAt, id), in causal order where the database
 * writes the records of one action a few milliseconds out of order: saving a draft stores its free check just before
 * the revision row, so a check is never placed before the revision it evaluated; locking stores the plan just before
 * the evaluation that authorised it (`lockEvaluationId`), so that evaluation is placed right before "Plan locked".
 * Displayed times never change.
 */
export function buildTimeline(inputs: TimelineInputs, display: TimeDisplay = STRATEGY_TIME): TimelineItem[] {
  const trade = inputs.trade;
  const tick = inputs.instrument?.tickSize ?? null;
  const step = inputs.instrument?.quantityStep ?? null;
  const entryRecordedAt = trade.entry_recorded_at ?? (trade.origin === "PLANNED" ? null : trade.created_at);
  const hasEntry = trade.origin !== "PLANNED" || trade.entry_recorded_at !== null || trade.entered_at !== null;
  const hasClose = trade.exited_at !== null;
  const endedAt = trade.origin === "PLANNED" ? inputs.planEndedAt ?? null : null;
  const placed: { item: TimelineItem; orderAt: string; rank: number }[] = [];

  const timingOf = (recordedAt: string, storedPhase?: StoredPhase | null): TimingResult => classifyTiming({
    recordedAt,
    storedPhase: storedPhase ?? inferStoredPhase(recordedAt, entryRecordedAt, trade.close_recorded_at, endedAt),
    origin: trade.origin,
    entryAt: trade.entered_at,
    entryRecordedAt,
    exitAt: trade.exited_at,
    tradeCreatedAt: trade.created_at,
    endedAt,
  });
  const push = (item: Omit<TimelineItem, "timeLabel" | "timing" | "flags"> & { timing?: TimingResult } & Placement) => {
    const { timing = timingOf(item.recordedAt), orderAt = item.at, rank = 0, ...rest } = item;
    placed.push({ item: { ...rest, timing: timing.timing, flags: timing.flags, timeLabel: timeLabel(item.at, item.recordedAt, display) }, orderAt, rank });
  };
  const beforeEntry: TimingResult = { timing: "BEFORE_ENTRY", flags: [] };

  for (const revision of inputs.revisions ?? []) {
    push({
      id: `revision:${revision.proposalId}`, kind: "DRAFT_REVISION", at: revision.createdAt, recordedAt: revision.createdAt,
      title: revision.revision === 1 ? "Draft created" : `Draft revised · revision ${revision.revision}`,
      source: `revision:${revision.proposalId}`, details: { revision: revision.revision }, timing: beforeEntry,
    });
  }

  const revisedAt = new Map((inputs.revisions ?? []).map(revision => [revision.proposalId, revision.createdAt] as const));
  for (const check of inputs.riskChecks ?? []) {
    const parsed = check.decision === "BLOCKED" ? storedRiskSchema.safeParse(check.result) : null;
    const firstReason = parsed?.success ? explainReport(parsed.data, inputs.explainLookup?.(check, parsed.data)).blocking[0]?.detail : undefined;
    push({
      id: `check:${check.id}`, kind: "RISK_CHECK", at: check.recordedAt, recordedAt: check.recordedAt,
      title: `Risk check: ${check.decision === "APPROVED" ? "Approved" : "Blocked"}`, body: firstReason, source: `check:${check.id}`,
      ...checkPlacement(check, check.proposalId !== undefined ? revisedAt.get(check.proposalId) : undefined, check.id === inputs.lockEvaluationId ? trade.locked_at : null),
    });
  }

  if (trade.plan_id !== null && trade.locked_at !== null) {
    const versions = [trade.risk_plan_version, trade.strategy_version].filter((v): v is string => Boolean(v));
    push({
      id: `plan:${trade.plan_id}`, kind: "PLAN_LOCKED", at: trade.locked_at, recordedAt: trade.locked_at, title: "Plan locked",
      body: versions.length ? versions.join(" · ") : undefined, source: `plan:${trade.plan_id}`, timing: beforeEntry,
    });
  }

  for (const event of inputs.legacyEvents ?? []) {
    const rendered =
      (event.eventType === "PLAN_LOCKED" && trade.locked_at !== null)
      || (event.eventType === "TRADE_OPENED" && hasEntry)
      || (event.eventType === "TRADE_CLOSED" && hasClose)
      || (event.eventType === "PLAN_CANCELLED" && inputs.disposition != null)
      || (event.eventType === "NOTE_ADDED" && isLegacyTagNote(event));
    if (rendered) continue;
    const userTime = event.eventType === "TRADE_OPENED" || event.eventType === "TRADE_CLOSED";
    const note = event.eventType === "NOTE_ADDED";
    push({
      id: `event:${event.id}`, kind: note ? "NOTE" : "TRADE_EVENT", at: userTime ? event.occurredAt : event.recordedAt, recordedAt: event.recordedAt,
      title: note ? "Note" : LEGACY_EVENT_TITLES[event.eventType] ?? "Trade event",
      body: textOf(event.payload.note) ?? textOf(event.payload.reason) ?? undefined, source: `event:${event.id}`,
    });
  }

  if (hasEntry) {
    const at = trade.entered_at ?? trade.created_at;
    const recordedAt = trade.entry_recorded_at ?? trade.created_at;
    const parts = [
      trade.entry_price !== null ? `Entry ${formatPrice(trade.entry_price, tick)}` : "Entry price not recorded",
      trade.quantity !== null ? `${formatQuantity(trade.quantity, step)}${quantityUnit(inputs)}` : null,
      trade.entered_at === null ? "entry time not recorded" : null,
    ].filter((part): part is string => part !== null);
    push({
      id: `entry:${trade.id}`, kind: "ENTRY", at, recordedAt, title: "Trade opened", body: parts.join(" · "),
      source: `execution:${trade.id}`, timing: { timing: "WHILE_LIVE", flags: [] },
    });
    if (trade.oversize === true && trade.quantity !== null && trade.planned_quantity !== null) {
      push({
        id: `size:${trade.id}`, kind: "SIZE_DEVIATION", at, recordedAt,
        title: `Size above plan: ${formatQuantity(trade.quantity, step)} vs ${formatQuantity(trade.planned_quantity, step)}${quantityUnit(inputs)}`,
        source: `execution:${trade.id}`, timing: { timing: "WHILE_LIVE", flags: [] },
      });
    }
  }

  for (const entry of inputs.journal ?? []) {
    push({
      id: `journal:${entry.id}`, kind: "JOURNAL", journalKind: entry.kind, at: entry.recordedAt, recordedAt: entry.recordedAt,
      title: journalTitle(entry, inputs), body: entry.body ?? undefined, details: entry.details, source: `journal:${entry.id}`,
      timing: timingOf(entry.recordedAt, entry.phase),
    });
  }

  for (const evidence of inputs.evidence ?? []) {
    const name = evidence.kind === "V2" ? evidenceName(evidence.label, evidence.timeframe) : evidenceName(legacyEvidenceLabel(evidence.role), evidence.role);
    const caption = evidence.kind === "V2" ? textOf(evidence.caption) ?? undefined : undefined;
    push({
      id: `evidence-added:${evidence.id}`, kind: "EVIDENCE_ADDED", at: evidence.recordedAt, recordedAt: evidence.recordedAt,
      title: `${name} added`, body: caption, evidenceId: evidence.id, source: `evidence:${evidence.id}`,
      timing: timingOf(evidence.recordedAt, evidence.kind === "V2" ? evidence.phase : null),
    });
    if (evidence.removedAt) {
      push({
        id: `evidence-removed:${evidence.id}`, kind: "EVIDENCE_REMOVED", at: evidence.removedAt, recordedAt: evidence.removedAt,
        title: `${name} removed`, evidenceId: evidence.id, source: `evidence:${evidence.id}`,
      });
    }
  }

  for (const set of inputs.tagSets ?? []) {
    push({ id: `tags:${set.source}:${set.id}`, kind: "TAGS", at: set.recordedAt, recordedAt: set.recordedAt, title: "Tags updated", body: tagSummary(set), source: `tags:${set.id}` });
  }

  if (inputs.disposition) {
    const disposition = inputs.disposition;
    // The skip or cancellation is the last decision before an entry that never happened: it keeps its place.
    push({
      id: `disposition:${trade.id}`, kind: "DISPOSITION", at: disposition.recordedAt, recordedAt: disposition.recordedAt,
      title: disposition.status === "SKIPPED" ? "Trade skipped" : "Trade cancelled", body: disposition.reason ?? undefined, source: `disposition:${trade.id}`,
      timing: beforeEntry,
    });
  }

  if (trade.exited_at !== null) {
    const result = trade.realized_r !== null ? formatR(trade.realized_r) : trade.net_pnl !== null ? formatSignedMoney(trade.net_pnl, trade.currency) : null;
    push({
      id: `close:${trade.id}`, kind: "CLOSE", at: trade.exited_at, recordedAt: trade.close_recorded_at ?? trade.exited_at,
      title: result ? `Trade closed: ${result}` : "Trade closed",
      body: trade.exit_price !== null ? `Exit ${formatPrice(trade.exit_price, tick)}` : undefined,
      source: `close:${trade.id}`, timing: { timing: "AFTER_CLOSE", flags: [] },
    });
  }

  for (const analysis of inputs.aiAnalyses ?? []) {
    push({
      id: `ai:${analysis.id}`, kind: "AI_ANALYSIS", at: analysis.recordedAt, recordedAt: analysis.recordedAt,
      title: aiTitle(analysis), body: textOf(analysis.summary) ?? undefined, source: `ai:${analysis.id}`,
    });
  }

  for (const event of inputs.lifecycleEvents ?? []) {
    const title = event.event === "DRAFT_DISCARDED" ? "Draft discarded" : event.event === "REVIEW_COMPLETED" ? "Review completed" : "Review reopened";
    push({
      id: `lifecycle:${event.id}`, kind: event.event, at: event.recordedAt, recordedAt: event.recordedAt, title, body: event.reason ?? undefined, source: `lifecycle:${event.id}`,
      // Only a draft can be discarded: the discard is its last decision before an entry and keeps its place.
      ...(event.event === "DRAFT_DISCARDED" ? { timing: beforeEntry } : {}),
    });
  }

  return placed
    .sort((a, b) => compareInstants(a.orderAt, b.orderAt) || a.rank - b.rank || compareInstants(a.item.at, b.item.at)
      || compareInstants(a.item.recordedAt, b.item.recordedAt) || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .map(entry => entry.item);
}

/**
 * Where a risk check sits (causal order, spec §5.4). A check evaluates a saved revision, so it is never placed before
 * that revision: at the revision's instant it follows it (`revisedAt`, when the save wrote the check first). The check
 * that authorised a lock is never placed after the lock: at the lock's instant it precedes it (`lockedAt`, given only
 * for that evaluation). Every other check keeps its own time.
 */
function checkPlacement(check: TimelineRiskCheck, revisedAt: string | undefined, lockedAt: string | null): Placement {
  if (lockedAt !== null && compareInstants(check.recordedAt, lockedAt) >= 0) return { orderAt: lockedAt, rank: -1 };
  if (revisedAt !== undefined && compareInstants(revisedAt, check.recordedAt) >= 0) return { orderAt: revisedAt, rank: 1 };
  return {};
}

export interface TimingGroup {
  timing: Timing;
  label: string;
  items: TimelineItem[];
}

/** Groups items into the three bands in order (empty bands included), preserving item order. */
export function groupByTiming(items: readonly TimelineItem[]): TimingGroup[] {
  return TIMING_ORDER.map(timing => ({ timing, label: TIMING_LABELS[timing], items: items.filter(item => item.timing === timing) }));
}
