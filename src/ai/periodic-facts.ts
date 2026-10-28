import Decimal from "decimal.js";
import type { JournalTrade } from "@/domain/analytics";
import { type ExplainLookup, explainReport } from "@/domain/risk-explain";
import type { StoredRiskReport } from "@/domain/risk-report";
import { classifyTiming, inferStoredPhase, type JournalKind, type StoredPhase, type Timing, type TimingFlag } from "@/domain/timeline";
import type { PlanRow } from "@/lib/data";
import type { ReviewEvent } from "./trade-review-context";

/**
 * Compact deterministic facts of one closed planned trade for the periodic reviews (WEEKLY_REVIEW_FACTS_V2,
 * RECENT_TRADES_FACTS_V2, MONTHLY_REVIEW_FACTS_V2). Strategy and risk versions are carried once per snapshot and
 * referenced by id; the Risk Engine report is reduced to what a process review uses (decision, findings as stable
 * codes with their human sentence, risk, RR, size, rule summary, report version); V2 journal entries and tags are
 * included with the timing Trading OS computed (spec §5.3), so after-close text can never pose as pre-entry evidence.
 * Long texts are shortened explicitly (`textShortened`), never silently; no record is left out.
 */

/**
 * Characters kept of each text; a shortened text says so in its record. A plan narrative keeps its start and its last
 * `narrativeTail` characters (a thesis usually closes with its invalidation); a journal or note text keeps its start.
 */
export const PERIODIC_TEXT_LIMITS = Object.freeze({ narrative: 400, narrativeTail: 150, entry: 200 });
/** Marks the omitted middle of a shortened plan narrative. */
const NARRATIVE_GAP = " … ";

export type RiskVersionRow = {
  id: string; version: string; effective_day: string; max_risk_percent: string; max_daily_trades: number; min_rr: string;
  rr_policy: "BLOCK" | "WARN"; news_policy: "BLOCK" | "WARN"; daily_risk_cap: string | null; daily_loss_cap: string | null;
};
export interface PeriodicStrategy { id: string; version: string; rules: Record<string, unknown> }

/** A V2 journal entry (`trade_journal_entries`) of an included trade, with the phase stored at creation. */
export interface PeriodicJournalEntry {
  id: string;
  kind: JournalKind;
  body: string | null;
  details: Record<string, unknown>;
  phase: StoredPhase;
  recordedAt: string;
}

/** Tags in force for the review: the latest V2 tag set in scope, or (recent trades only) the legacy V1 tags. */
export interface PeriodicTags {
  setupGrade: string | null;
  liquidityContext: string | null;
  mssTimeframe: string | null;
  tags: readonly string[];
  source: "V2" | "V1";
  recordedAt: string | null;
}

export interface PeriodicTradeSource {
  plan: PlanRow;
  trade: JournalTrade;
  /** `trades.id` of the plan's V2 trade: the canonical trade identity, cited as `trade:<id>`. */
  tradeRecordId: string;
  /** Server times of the entry and the close, used to infer the phase of V1 events (which store none). */
  entryRecordedAt: string | null;
  closeRecordedAt: string | null;
  strategy: PeriodicStrategy;
  risk: RiskVersionRow;
  /** V1 `trade_events` in scope. */
  events: ReviewEvent[];
  /** V2 journal entries in scope. */
  journal: PeriodicJournalEntry[];
  tags: PeriodicTags | null;
}

const PROPOSAL_FIELDS = ["direction", "model", "entry", "stop", "target", "riskPercent", "news", "contractConfirmed", "contradiction"] as const;
const EVENT_PAYLOAD_KEYS = ["note", "reason", "entry", "entry_price", "quantity", "exit", "exit_price", "fees", "stop", "target", "price", "status", "realized_r", "outcome", "setup_grade", "liquidity_context", "mss_timeframe", "source"];
const DETAIL_KEYS = ["price", "quantity", "percent"];

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key) && value[key] !== null && value[key] !== undefined).map(key => [key, value[key]]));
}

/** At most `limit` characters (code points), cut at a word boundary when one is near; `shortened` says whether it was cut. */
export function boundedText(value: string, limit: number): { text: string; shortened: boolean } {
  const text = value.trim();
  const points = [...text];
  if (points.length <= limit) return { text, shortened: false };
  const head = points.slice(0, limit - 1).join("");
  const space = head.lastIndexOf(" ");
  return { text: `${(space >= limit * 0.6 ? head.slice(0, space) : head).trimEnd()}…`, shortened: true };
}

/**
 * At most `limit` characters (code points) that keep both the start of the text and its last `tail` characters around a
 * marked gap, each cut at a word boundary when one is near; `shortened` says whether anything was left out.
 */
export function boundedEnds(value: string, limit: number, tail: number): { text: string; shortened: boolean } {
  const text = value.trim();
  const points = [...text];
  if (points.length <= limit) return { text, shortened: false };
  const headLength = limit - tail - [...NARRATIVE_GAP].length;
  let head = points.slice(0, headLength).join("");
  const space = head.lastIndexOf(" ");
  if (space >= headLength * 0.6) head = head.slice(0, space);
  let end = points.slice(points.length - tail).join("");
  const boundary = end.indexOf(" ");
  if (boundary >= 0 && boundary <= tail * 0.4) end = end.slice(boundary + 1);
  return { text: `${head.trimEnd()}${NARRATIVE_GAP}${end.trimStart()}`, shortened: true };
}

/** `trimmed text` plus `textShortened: true` when it was cut; nothing for an empty text. */
function textFields(value: unknown, limit: number): { text?: string; textShortened?: true } {
  if (typeof value !== "string" || value.trim() === "") return {};
  const { text, shortened } = boundedText(value, limit);
  return shortened ? { text, textShortened: true } : { text };
}

/** Whether the filled size was above, at or below the planned size (exact decimals). */
function sizeVersusPlan(quantity: string | null, planned: string | null): "ABOVE_PLAN" | "AS_PLANNED" | "BELOW_PLAN" | null {
  if (quantity === null || planned === null) return null;
  try {
    const comparison = new Decimal(quantity).comparedTo(planned);
    return comparison > 0 ? "ABOVE_PLAN" : comparison < 0 ? "BELOW_PLAN" : "AS_PLANNED";
  } catch {
    return null;
  }
}

/**
 * The Risk Engine result a plan was locked with, reduced for a periodic review: report version, decision,
 * session, every BLOCK and WARN finding as `{code, text}` (the exact sentence of spec §6.5), the risk amount and planned
 * RR from the stored calculations, and the rule summary. Requested risk and size are in the plan and the execution;
 * low-priority notes (unconfigured caps, costs) are configuration, not findings. Stored values are copied, never
 * recomputed.
 */
export function compactRiskReport(report: StoredRiskReport, lookup: ExplainLookup) {
  const explained = explainReport(report, lookup);
  const reportVersion = "reportVersion" in report ? report.reportVersion : "legacy";
  const ruleResults = "ruleResults" in report ? report.ruleResults : null;
  const notEvaluated = ruleResults?.filter(rule => rule.outcome === "NOT_EVALUATED").map(rule => rule.rule) ?? [];
  return {
    reportVersion,
    decision: explained.decision,
    session: report.session,
    riskAmount: report.calculations?.nominalRisk ?? null,
    plannedRR: report.calculations?.plannedRR ?? null,
    // A locked plan was approved, so blocking findings are listed only when a stored report has any.
    ...(explained.blocking.length ? { blocking: explained.blocking.map(issue => ({ code: issue.code, text: issue.detail })) } : {}),
    warnings: explained.warnings.map(issue => ({ code: issue.code, text: issue.detail })),
    rules: ruleResults === null ? null : {
      passed: ruleResults.filter(rule => rule.outcome === "PASS").length,
      ...(notEvaluated.length ? { notEvaluated } : {}),
    },
  };
}

/** The risk version as the snapshot carries it (once per version). */
export function periodicRiskVersion(risk: RiskVersionRow) {
  return pick(risk, ["id", "version", "effective_day", "max_risk_percent", "max_daily_trades", "min_rr", "rr_policy", "news_policy", "daily_risk_cap", "daily_loss_cap"]) as Partial<RiskVersionRow> & { id: string; version: string };
}

/** The strategy version as the snapshot carries it (once per version; structured rules, no written prompt, spec §11.4). */
export function periodicStrategy(strategy: PeriodicStrategy) {
  return { id: strategy.id, version: strategy.version, rules: strategy.rules };
}

interface VersionIdentity { id: string; version: string }

/**
 * The strategy and risk versions the trades used, once each, in first-use order. Trades name the version they used, so
 * a name must identify exactly one version of the snapshot (Trading OS names versions uniquely per account).
 */
function onceEach<S extends VersionIdentity, R extends VersionIdentity>(sources: readonly { strategy: S; risk: R }[]) {
  const strategies = new Map<string, S>();
  const risks = new Map<string, R>();
  const names = new Map<string, string>();
  const name = (kind: string, version: string, id: string) => {
    const known = names.get(`${kind}:${version}`);
    if (known !== undefined && known !== id) throw new Error("Version names are ambiguous in this snapshot");
    names.set(`${kind}:${version}`, id);
  };
  for (const { strategy, risk } of sources) {
    name("strategy", strategy.version, strategy.id);
    name("risk", risk.version, risk.id);
    if (!strategies.has(strategy.id)) strategies.set(strategy.id, strategy);
    if (!risks.has(risk.id)) risks.set(risk.id, risk);
  }
  return { strategies: [...strategies.values()], risks: [...risks.values()] };
}

/** The strategy and risk versions of a snapshot as the detailed facts carry them, once each, in first-use order. */
export function snapshotVersions(sources: readonly Pick<PeriodicTradeSource, "strategy" | "risk">[]) {
  const { strategies, risks } = onceEach(sources);
  return { strategyVersions: strategies.map(periodicStrategy), riskVersions: risks.map(periodicRiskVersion) };
}

/** Only the identities (`id`, `version`) of the versions the trades used, once each, in first-use order. */
export function versionIdentities(sources: readonly { strategy: VersionIdentity; risk: VersionIdentity }[]) {
  const { strategies, risks } = onceEach(sources);
  return {
    strategyVersions: strategies.map(({ id, version }) => ({ id, version })),
    riskVersions: risks.map(({ id, version }) => ({ id, version })),
  };
}

export interface PeriodicTradeExtras {
  /** Session and weekday of the entry in fixed UTC−5 (deterministic, from `enrichTrades`). */
  session: string;
  weekday: string;
}

/**
 * One included trade. `tradeId` stays the locked plan id the database verifies the sample with; `tradeRecordId` is
 * the V2 trade the citation `trade:<tradeRecordId>` and every link resolve to. Strategy and risk versions are named
 * (`strategyVersion`, `riskPlanVersion`) and defined once in the snapshot's version lists.
 */
export function periodicTrade(source: PeriodicTradeSource, extras: PeriodicTradeExtras) {
  const { plan, trade } = source;
  if (plan.id !== trade.id || plan.account_id !== trade.account_id) throw new Error("Trade context ownership mismatch");
  const timing = (recordedAt: string, storedPhase: StoredPhase): { timing: Timing; flags?: TimingFlag[] } => {
    const result = classifyTiming({
      recordedAt, storedPhase, origin: "PLANNED", entryAt: trade.entered_at, entryRecordedAt: source.entryRecordedAt, exitAt: trade.exited_at,
    });
    return result.flags.length ? { timing: result.timing, flags: result.flags } : { timing: result.timing };
  };
  const proposal = plan.proposal;
  const narrative = typeof proposal.narrative === "string"
    ? boundedEnds(proposal.narrative, PERIODIC_TEXT_LIMITS.narrative, PERIODIC_TEXT_LIMITS.narrativeTail)
    : null;
  const lookup: ExplainLookup = {
    riskPlan: {
      id: source.risk.id, maxRiskPercent: source.risk.max_risk_percent, minRR: source.risk.min_rr, dailyRiskCap: source.risk.daily_risk_cap,
      dailyLossCap: source.risk.daily_loss_cap, rrPolicy: source.risk.rr_policy, newsPolicy: source.risk.news_policy, maxDailyTrades: source.risk.max_daily_trades,
    },
    proposal: {
      direction: proposal.direction === "LONG" || proposal.direction === "SHORT" ? proposal.direction : undefined,
      riskPercent: typeof proposal.riskPercent === "string" ? proposal.riskPercent : undefined,
    },
    strategy: source.strategy.version,
  };
  return {
    tradeId: plan.id,
    tradeRecordId: source.tradeRecordId,
    originalPlan: {
      lockedAt: plan.locked_at, tradingDay: plan.trading_day, instrument: plan.instrument.symbol,
      proposal: { ...pick(proposal, PROPOSAL_FIELDS), ...(narrative ? { narrative: narrative.text } : {}) },
      ...(narrative?.shortened ? { narrativeShortened: true as const } : {}),
    },
    strategyVersion: source.strategy.version,
    riskPlanVersion: source.risk.version,
    deterministic: compactRiskReport(plan.risk_result, lookup),
    execution: {
      entry_price: trade.entry_price, quantity: trade.quantity, planned_quantity: trade.planned_quantity,
      size: sizeVersusPlan(trade.quantity, trade.planned_quantity),
      entered_at: trade.entered_at, exit_price: trade.exit_price, exited_at: trade.exited_at, fees: trade.fees, net_pnl: trade.net_pnl,
      realized_r: trade.realized_r, outcome: trade.outcome,
    },
    session: extras.session,
    weekday: extras.weekday,
    tags: source.tags ? {
      setupGrade: source.tags.setupGrade, liquidityContext: source.tags.liquidityContext, mssTimeframe: source.tags.mssTimeframe,
      tags: [...source.tags.tags], source: source.tags.source,
      ...(source.tags.recordedAt ? { timing: timing(source.tags.recordedAt, inferStoredPhase(source.tags.recordedAt, source.entryRecordedAt, source.closeRecordedAt)).timing } : {}),
    } : null,
    events: source.events.map(event => ({
      id: event.id, event_type: event.event_type, occurred_at: event.occurred_at, recorded_at: event.recorded_at,
      ...timing(event.recorded_at, inferStoredPhase(event.recorded_at, source.entryRecordedAt, source.closeRecordedAt)),
      payload: (() => {
        const payload = pick(event.payload, EVENT_PAYLOAD_KEYS.filter(key => key !== "note"));
        const note = textFields(event.payload.note, PERIODIC_TEXT_LIMITS.entry);
        return note.text === undefined ? payload : { ...payload, note: note.text, ...(note.textShortened ? { noteShortened: true } : {}) };
      })(),
    })),
    journal: source.journal.map(entry => ({
      id: entry.id, kind: entry.kind, recordedAt: entry.recordedAt, ...timing(entry.recordedAt, entry.phase),
      ...textFields(entry.body, PERIODIC_TEXT_LIMITS.entry),
      ...(Object.keys(pick(entry.details, DETAIL_KEYS)).length ? { details: pick(entry.details, DETAIL_KEYS) } : {}),
    })),
  };
}
export type PeriodicTrade = ReturnType<typeof periodicTrade>;

/** Scope sentences every V2 periodic snapshot states (facts, not instructions). */
export const PERIODIC_RECORD_RULES = [
  "Every journal entry and event carries the timing Trading OS computed from server times: BEFORE_ENTRY, WHILE_LIVE or AFTER_CLOSE.",
  "AFTER_CLOSE records are hindsight explanations written after the trade ended; they are never evidence of what was known or planned before entry.",
  `A plan narrative longer than ${PERIODIC_TEXT_LIMITS.narrative} characters keeps its start and its last ${PERIODIC_TEXT_LIMITS.narrativeTail} characters around a marked gap (…), so a closing invalidation stays visible; a journal or note text longer than ${PERIODIC_TEXT_LIMITS.entry} characters keeps its first ${PERIODIC_TEXT_LIMITS.entry}.`,
  "Shortened texts are marked and continue in the trade's records: never conclude that something is missing or was not written because a shortened text does not show it. No record is left out.",
  "Plan lock, entry and close events are represented by each trade's plan and execution facts.",
  "Cite a trade as trade:<tradeRecordId>, a journal entry as journal:<id> and an event as event:<id>. Strategy and risk versions are supplied once; trades name the version they used.",
].join(" ");
