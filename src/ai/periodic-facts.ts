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
 *
 * The facts are written compactly because every token of them counts toward the operation's reviewed input limit:
 * UTC instants to the minute in short ISO 8601 (`2026-10-27T08:32Z`; database times carry microseconds no review
 * reads, and every timing label and flag is computed from the exact time first), exact decimals without trailing
 * fractional zeros, a journal entry as one row (`PERIODIC_JOURNAL_COLUMNS`), record lists and tags only where a trade
 * has them, and values every trade would repeat stated once: a plan's usual flags, the current report version and,
 * when the snapshot has only one, the strategy or risk version (`PERIODIC_RECORD_RULES` says how to read them).
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

/** A UTC instant as PostgreSQL, PostgREST or `toISOString` write it (`+00:00`, `-00`, `Z`; optional seconds and fraction). */
const UTC_INSTANT = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]00(?::?00)?)$/;

/**
 * The UTC instant's minute in short ISO 8601 (`2026-10-27T20:19:04.927840+00:00` → `2026-10-27T20:19Z`): seconds and
 * fractions are cut off, never rounded up, so a time never moves later. Only what the review reads is shortened: the
 * timing of every record (`classifyTiming`) and the scope checks use the exact instant. Any other text, an instant in
 * another zone included, is returned unchanged.
 */
export function compactInstant(value: string): string {
  const match = UTC_INSTANT.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : value;
}

/** An exact decimal string as PostgreSQL `numeric::text` writes it. */
const DECIMAL_TEXT = /^([+-]?\d+)\.(\d*?)0+$/;

/**
 * The same exact decimal without trailing fractional zeros (`"4.25000000"` → `"4.25"`, `"2500.00"` → `"2500"`); every
 * other value, a number or a decimal without trailing zeros included, is returned unchanged.
 */
export function compactDecimal<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  const match = DECIMAL_TEXT.exec(value);
  if (!match) return value;
  const whole = match[2] ? `${match[1]}.${match[2]}` : match[1];
  return /^[+-]0$/.test(whole) ? "0" : whole;
}

/** The given fields of `value` with exact decimals compacted; absent and null fields stay as they are. */
function compactDecimals<T extends Record<string, unknown>>(value: T, keys: readonly (keyof T)[]): T {
  const copy = { ...value };
  for (const key of keys) if (Object.hasOwn(copy, key)) copy[key] = compactDecimal(copy[key]) as T[keyof T];
  return copy;
}

/**
 * Columns of one journal entry row in the V2 periodic facts: `[id, kind, recordedAt, timing, text, extra]`. `text` is
 * null for an entry without one; `extra` is present only when the entry has timing `flags`, a shortened text
 * (`textShortened`) or `details` (price, quantity, percent).
 */
export const PERIODIC_JOURNAL_COLUMNS = Object.freeze(["id", "kind", "recordedAt", "timing", "text", "extra"] as const);

export interface PeriodicJournalExtra {
  flags?: TimingFlag[];
  textShortened?: true;
  details?: Record<string, unknown>;
}
export type PeriodicJournalRow =
  | [id: string, kind: JournalKind, recordedAt: string, timing: Timing, text: string | null]
  | [id: string, kind: JournalKind, recordedAt: string, timing: Timing, text: string | null, extra: PeriodicJournalExtra];

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

/** The Risk Engine report version of current plans: a compact result names its version only when it is older. */
export const CURRENT_RISK_REPORT_VERSION = "1.2";

/**
 * The Risk Engine result a plan was locked with, reduced for a periodic review: report version (only when older than
 * `CURRENT_RISK_REPORT_VERSION`), decision, session, every BLOCK and WARN finding as `{code, text}` (the exact sentence
 * of spec §6.5), the risk amount and planned RR from the stored calculations, and the rule summary. Requested risk and
 * size are in the plan and the execution; low-priority notes (unconfigured caps, costs) are configuration, not findings.
 * Stored values are copied, never recomputed; findings are listed only when the report has any.
 */
export function compactRiskReport(report: StoredRiskReport, lookup: ExplainLookup) {
  const explained = explainReport(report, lookup);
  const reportVersion = "reportVersion" in report ? report.reportVersion : "legacy";
  const ruleResults = "ruleResults" in report ? report.ruleResults : null;
  const notEvaluated = ruleResults?.filter(rule => rule.outcome === "NOT_EVALUATED").map(rule => rule.rule) ?? [];
  return {
    ...(reportVersion === CURRENT_RISK_REPORT_VERSION ? {} : { reportVersion }),
    decision: explained.decision,
    session: report.session,
    riskAmount: compactDecimal(report.calculations?.nominalRisk ?? null),
    plannedRR: compactDecimal(report.calculations?.plannedRR ?? null),
    // A locked plan was approved, so blocking findings are listed only when a stored report has any.
    ...(explained.blocking.length ? { blocking: explained.blocking.map(issue => ({ code: issue.code, text: issue.detail })) } : {}),
    ...(explained.warnings.length ? { warnings: explained.warnings.map(issue => ({ code: issue.code, text: issue.detail })) } : {}),
    rules: ruleResults === null ? null : {
      passed: ruleResults.filter(rule => rule.outcome === "PASS").length,
      ...(notEvaluated.length ? { notEvaluated } : {}),
    },
  };
}

/** The risk version as the snapshot carries it (once per version; unset caps are left out, exact decimals compacted). */
export function periodicRiskVersion(risk: RiskVersionRow) {
  const fields = pick(risk, ["id", "version", "effective_day", "max_risk_percent", "max_daily_trades", "min_rr", "rr_policy", "news_policy", "daily_risk_cap", "daily_loss_cap"]);
  return compactDecimals(fields, ["max_risk_percent", "min_rr", "daily_risk_cap", "daily_loss_cap"]) as Partial<RiskVersionRow> & { id: string; version: string };
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

/**
 * Which version kinds the trades of a snapshot must name: only a kind with more than one version in the snapshot. With
 * one strategy (or risk) version, every trade used it, so naming it in each trade would repeat the version list.
 */
export function namedVersions(sources: readonly { strategy: VersionIdentity; risk: VersionIdentity }[]): PeriodicTradeExtras["named"] {
  return { strategy: new Set(sources.map(source => source.strategy.id)).size > 1, risk: new Set(sources.map(source => source.risk.id)).size > 1 };
}

export interface PeriodicTradeExtras {
  /** Session and weekday of the entry in fixed UTC−5 (deterministic, from `enrichTrades`). */
  session: string;
  weekday: string;
  /** Whether the trade names its strategy and risk version (`namedVersions` of the snapshot). */
  named: { strategy: boolean; risk: boolean };
}

/** A plan's usual flags, which a compact proposal leaves out: the contract was confirmed and no contradiction was flagged. */
const USUAL_PLAN_FLAGS: Readonly<Record<string, unknown>> = Object.freeze({ contractConfirmed: true, contradiction: false });

/** The plan proposal's fields with exact decimals compacted and its usual flags (`USUAL_PLAN_FLAGS`) left out. */
function compactProposal(proposal: Record<string, unknown>): Record<string, unknown> {
  const fields = compactDecimals(pick(proposal, PROPOSAL_FIELDS), ["entry", "stop", "target", "riskPercent"]);
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => !(Object.hasOwn(USUAL_PLAN_FLAGS, key) && USUAL_PLAN_FLAGS[key] === value)));
}

/** A journal entry as one row of `PERIODIC_JOURNAL_COLUMNS`: its text bounded, its details' decimals compacted. */
function journalRow(entry: PeriodicJournalEntry, timed: { timing: Timing; flags?: TimingFlag[] }): PeriodicJournalRow {
  const text = textFields(entry.body, PERIODIC_TEXT_LIMITS.entry);
  const details = compactDecimals(pick(entry.details, DETAIL_KEYS), DETAIL_KEYS);
  const extra: PeriodicJournalExtra = {
    ...(timed.flags ? { flags: timed.flags } : {}),
    ...(text.textShortened ? { textShortened: true as const } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
  const recordedAt = compactInstant(entry.recordedAt);
  return Object.keys(extra).length ? [entry.id, entry.kind, recordedAt, timed.timing, text.text ?? null, extra] : [entry.id, entry.kind, recordedAt, timed.timing, text.text ?? null];
}

/**
 * One included trade. `tradeId` stays the locked plan id the database verifies the sample with; `tradeRecordId` is
 * the V2 trade the citation `trade:<tradeRecordId>` and every link resolve to. Strategy and risk versions are defined
 * once in the snapshot's version lists; a trade names its version (`strategyVersion`, `riskPlanVersion`) when the
 * snapshot has more than one of that kind (`extras.named`). Tags, V1 events and journal entries (rows of
 * `PERIODIC_JOURNAL_COLUMNS`) are present only when the trade has them.
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
  const instant = (value: string | null) => (value === null ? null : compactInstant(value));
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
  const events = source.events.map(event => ({
    id: event.id, event_type: event.event_type, occurred_at: compactInstant(event.occurred_at), recorded_at: compactInstant(event.recorded_at),
    ...timing(event.recorded_at, inferStoredPhase(event.recorded_at, source.entryRecordedAt, source.closeRecordedAt)),
    payload: (() => {
      const payload = Object.fromEntries(Object.entries(pick(event.payload, EVENT_PAYLOAD_KEYS.filter(key => key !== "note"))).map(([key, value]) => [key, compactDecimal(value)]));
      const note = textFields(event.payload.note, PERIODIC_TEXT_LIMITS.entry);
      return note.text === undefined ? payload : { ...payload, note: note.text, ...(note.textShortened ? { noteShortened: true } : {}) };
    })(),
  }));
  const journal = source.journal.map(entry => journalRow(entry, timing(entry.recordedAt, entry.phase)));
  return {
    tradeId: plan.id,
    tradeRecordId: source.tradeRecordId,
    originalPlan: {
      lockedAt: compactInstant(plan.locked_at), tradingDay: plan.trading_day, instrument: plan.instrument.symbol,
      proposal: { ...compactProposal(proposal), ...(narrative ? { narrative: narrative.text } : {}) },
      ...(narrative?.shortened ? { narrativeShortened: true as const } : {}),
    },
    ...(extras.named.strategy ? { strategyVersion: source.strategy.version } : {}),
    ...(extras.named.risk ? { riskPlanVersion: source.risk.version } : {}),
    deterministic: compactRiskReport(plan.risk_result, lookup),
    execution: {
      entry_price: compactDecimal(trade.entry_price), quantity: compactDecimal(trade.quantity), planned_quantity: compactDecimal(trade.planned_quantity),
      size: sizeVersusPlan(trade.quantity, trade.planned_quantity),
      entered_at: instant(trade.entered_at), exit_price: compactDecimal(trade.exit_price), exited_at: instant(trade.exited_at), fees: compactDecimal(trade.fees),
      net_pnl: compactDecimal(trade.net_pnl), realized_r: compactDecimal(trade.realized_r), outcome: trade.outcome,
    },
    session: extras.session,
    weekday: extras.weekday,
    ...(source.tags ? {
      tags: {
        setupGrade: source.tags.setupGrade, liquidityContext: source.tags.liquidityContext, mssTimeframe: source.tags.mssTimeframe,
        tags: [...source.tags.tags], source: source.tags.source,
        ...(source.tags.recordedAt ? { timing: timing(source.tags.recordedAt, inferStoredPhase(source.tags.recordedAt, source.entryRecordedAt, source.closeRecordedAt)).timing } : {}),
      },
    } : {}),
    ...(events.length ? { events } : {}),
    ...(journal.length ? { journal } : {}),
  };
}
export type PeriodicTrade = ReturnType<typeof periodicTrade>;

/** Scope sentences every V2 periodic snapshot with trade details states (facts, not instructions). */
export const PERIODIC_RECORD_RULES = [
  "Every journal entry and event carries the timing Trading OS computed from server times: BEFORE_ENTRY, WHILE_LIVE or AFTER_CLOSE.",
  "AFTER_CLOSE records are hindsight explanations written after the trade ended; they are never evidence of what was known or planned before entry.",
  `A journal entry is the row [${PERIODIC_JOURNAL_COLUMNS.join(", ")}]: text is null when the entry has none, and extra appears only with flags, textShortened or details.`,
  "A trade lists tags, events and journal entries only when it has them; its plan lock, entry and close are represented by its plan and execution facts.",
  "Times are UTC in ISO 8601 to the minute (timings were computed from the exact times); decimals are exact.",
  `A plan's proposal lists contractConfirmed only when the contract was not confirmed and contradiction only when one was flagged; a Risk Engine result lists reportVersion only when it is older than ${CURRENT_RISK_REPORT_VERSION}.`,
  `A plan narrative longer than ${PERIODIC_TEXT_LIMITS.narrative} characters keeps its start and its last ${PERIODIC_TEXT_LIMITS.narrativeTail} characters around a marked gap (…), so a closing invalidation stays visible; a journal or note text longer than ${PERIODIC_TEXT_LIMITS.entry} characters keeps its first ${PERIODIC_TEXT_LIMITS.entry}.`,
  "Shortened texts are marked and continue in the trade's records: never conclude that something is missing or was not written because a shortened text does not show it. No record is left out.",
  "Strategy and risk versions are supplied once each; a trade names its strategyVersion or riskPlanVersion only when more than one version of that kind is supplied, otherwise it used the only one.",
].join(" ");
