import "server-only";
import { cache } from "react";
import { z } from "zod";
import { type DailyStatus, dailyStatusV2 } from "@/domain/daily-status";
import { stripZeros } from "@/domain/format";
import {
  type DailyUsage, type DuplicateCandidate, dailyUsageSchema, type Instrument, isDuplicatePlan, type RiskContext, type RiskPlan,
} from "@/domain/risk";
import { isRiskReportCurrent, type StoredRiskReport } from "@/domain/risk-report";
import { strategyDay } from "@/domain/time-display";
import { type AccountContext, type ContextAccount, currentSession, type Db, getAccountContext, loadAccount } from "./account-context";

/**
 * Per-account risk workspace (docs/V2_ARCHITECTURE.md §6.7, §9, §14.1–14.2): everything the TypeScript engine preview,
 * the Today status card and the draft "Ready to lock" judgement need, read with the user's session:
 * - the latest account values (observation),
 * - the active risk plan by the private.active_risk_plan precedence rule (among versions effective on the strategy day,
 *   the newest created wins; V1 finding C9),
 * - the ICT V1.0 strategy version the engine evaluates,
 * - the latest instrument version per symbol (a newer version supersedes older ones in pickers),
 * - the daily usage of `get_daily_risk_usage` (planned + live-first trades, realized and external losses, open risk),
 * - the plans the account locked on the usage day (the DUPLICATE input of a preview),
 * - the server time of this request (never the browser clock).
 * All Accounts never invents an account: it returns one workspace per ACTIVE account.
 */

export interface WorkspaceObservation {
  id: string;
  balance: string;
  equity: string;
  /** Legacy V1 manual loss total of that day, when one was recorded. */
  grossLossToday: string | null;
  tradingDay: string;
  recordedAt: string;
}

export interface WorkspaceRiskPlan extends RiskPlan {
  effectiveDay: string;
  createdAt: string;
  overrideReason: string | null;
}

export interface WorkspaceStrategy {
  id: string;
  version: string;
  rules: Record<string, unknown>;
}

/** What an account still needs before a plan can be checked. */
export type WorkspaceGap = "ACCOUNT_VALUES" | "RISK_PLAN" | "STRATEGY" | "INSTRUMENTS";

export interface AccountWorkspace {
  account: ContextAccount;
  /** Server time of this request, ISO 8601 UTC. */
  now: string;
  /** Strategy day (fixed UTC−5) of `now`. */
  day: string;
  observation: WorkspaceObservation | null;
  riskPlan: WorkspaceRiskPlan | null;
  strategy: WorkspaceStrategy | null;
  /** Latest version of each symbol, ordered by symbol. */
  instruments: Instrument[];
  usage: DailyUsage;
  /**
   * The account's plans of the strategy day `usage.day` (`trade_plans`), oldest first. An identical proposal is a
   * DUPLICATE (spec §6.3): `riskContextFor(workspace, instrument, proposal)` decides it with `isDuplicatePlan`, and a
   * client preview passes this list to `isDuplicatePlan(proposal, todaysPlans)` itself. At most `maxDailyTrades` ≤ 100.
   */
  todaysPlans: DuplicateCandidate[];
  /** Today's trading status (spec §14.1); null while the account has no risk plan. */
  status: DailyStatus | null;
  gaps: WorkspaceGap[];
}

const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const canonical = (value: string) => stripZeros(value);
const canonicalOrNull = (value: string | null) => (value === null ? null : stripZeros(value));

const observationRow = z.object({
  id: z.uuid(), balance: decimalText, equity: decimalText, gross_loss_today: decimalText.nullable(), trading_day: z.string(), recorded_at: z.string(),
});
const riskPlanRow = z.object({
  id: z.uuid(), version: z.string(), effective_day: z.string(), created_at: z.string(), max_risk_percent: decimalText,
  default_risk_percent: decimalText.nullable(), max_daily_trades: z.number().int(), min_rr: decimalText, rr_policy: z.enum(["BLOCK", "WARN"]),
  news_policy: z.enum(["BLOCK", "WARN"]), daily_risk_cap: decimalText.nullable(), daily_loss_cap: decimalText.nullable(), override_reason: z.string().nullable(),
});
export const instrumentRow = z.object({
  id: z.uuid(), symbol: z.string(), currency: z.string(), quantity_unit: z.string(), tick_size: decimalText, pip_size: decimalText.nullable(),
  tick_value: decimalText, quantity_step: decimalText, minimum_quantity: decimalText, created_at: z.string(),
});
const strategyRow = z.object({ id: z.uuid(), version: z.string(), rules: z.record(z.string(), z.unknown()) });
const planRow = z.object({ instrument_version_id: z.uuid(), proposal: z.unknown() });

export const OBSERVATION_SELECT = "id,balance::text,equity::text,gross_loss_today::text,trading_day,recorded_at";
export const RISK_PLAN_SELECT = "id,version,effective_day,created_at,max_risk_percent::text,default_risk_percent::text,max_daily_trades,min_rr::text,"
  + "rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text,override_reason";
export const INSTRUMENT_SELECT = "id,symbol,currency,quantity_unit,tick_size::text,pip_size::text,tick_value::text,quantity_step::text,minimum_quantity::text,created_at";

export function toObservation(row: z.infer<typeof observationRow>): WorkspaceObservation {
  return {
    id: row.id, balance: canonical(row.balance), equity: canonical(row.equity), grossLossToday: canonicalOrNull(row.gross_loss_today),
    tradingDay: row.trading_day, recordedAt: row.recorded_at,
  };
}

export function toRiskPlan(row: z.infer<typeof riskPlanRow>): WorkspaceRiskPlan {
  return {
    id: row.id, version: row.version, maxRiskPercent: canonical(row.max_risk_percent), defaultRiskPercent: canonicalOrNull(row.default_risk_percent),
    maxDailyTrades: row.max_daily_trades, minRR: canonical(row.min_rr), rrPolicy: row.rr_policy, newsPolicy: row.news_policy,
    dailyRiskCap: canonicalOrNull(row.daily_risk_cap), dailyLossCap: canonicalOrNull(row.daily_loss_cap),
    effectiveDay: row.effective_day, createdAt: row.created_at, overrideReason: row.override_reason,
  };
}

export function toInstrument(row: z.infer<typeof instrumentRow>): Instrument {
  return {
    id: row.id, symbol: row.symbol, currency: row.currency, quantityUnit: row.quantity_unit, tickSize: canonical(row.tick_size),
    pipSize: canonicalOrNull(row.pip_size), tickValue: canonical(row.tick_value), quantityStep: canonical(row.quantity_step),
    minimumQuantity: canonical(row.minimum_quantity),
  };
}

export const parseObservationRow = (value: unknown) => toObservation(observationRow.parse(value));
export const parseRiskPlanRow = (value: unknown) => toRiskPlan(riskPlanRow.parse(value));
export const parseInstrumentRows = (value: unknown) => z.array(instrumentRow).parse(value ?? []);

/** Newest version of every symbol from rows ordered newest first; result ordered by symbol. */
export function latestInstrumentVersions(rows: readonly z.infer<typeof instrumentRow>[]): Instrument[] {
  const seen = new Map<string, z.infer<typeof instrumentRow>>();
  for (const row of rows) if (!seen.has(row.symbol)) seen.set(row.symbol, row);
  return [...seen.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)).map(toInstrument);
}

/**
 * The active risk plan of an account on a strategy day with the precedence of private.active_risk_plan: among the
 * versions already in effect, the newest created wins (`order by created_at desc, id desc`).
 */
export async function loadActiveRiskPlan(db: Db, userId: string, accountId: string, day: string): Promise<WorkspaceRiskPlan | null> {
  const { data, error } = await db.from("risk_plan_versions").select(RISK_PLAN_SELECT).eq("account_id", accountId).eq("user_id", userId)
    .lte("effective_day", day).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (error) throw new Error("Risk plan unavailable.");
  const [row] = z.array(riskPlanRow).parse(data ?? []);
  return row ? toRiskPlan(row) : null;
}

/** The latest recorded account values (balance/equity), newest recorded first. */
export async function loadLatestObservation(db: Db, userId: string, accountId: string): Promise<WorkspaceObservation | null> {
  const { data, error } = await db.from("account_observations").select(OBSERVATION_SELECT).eq("account_id", accountId).eq("user_id", userId)
    .order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (error) throw new Error("Account values unavailable.");
  const [row] = z.array(observationRow).parse(data ?? []);
  return row ? toObservation(row) : null;
}

/** `get_daily_risk_usage` of the database's current strategy day, strictly parsed (spec §6.7). */
export async function loadDailyUsage(db: Db, accountId: string): Promise<DailyUsage> {
  const { data, error } = await db.rpc("get_daily_risk_usage", { p_account_id: accountId });
  if (error) throw new Error("Daily usage unavailable.");
  return dailyUsageSchema.parse(data);
}

/**
 * The plans an account locked on strategy day `day` (the trades that already reserve a slot that day), oldest first:
 * the candidates of the DUPLICATE rule, read exactly as private.assess_plan reads them.
 */
export async function loadPlansOfDay(db: Db, userId: string, accountId: string, day: string): Promise<DuplicateCandidate[]> {
  const { data, error } = await db.from("trade_plans").select("instrument_version_id,proposal").eq("account_id", accountId).eq("user_id", userId)
    .eq("trading_day", day).order("locked_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error("Today's plans are unavailable.");
  return z.array(planRow).parse(data ?? []).map(row => ({ instrumentVersionId: row.instrument_version_id, proposal: row.proposal }));
}

/** Loads the workspace of one account at `now` (server time). */
export async function loadAccountWorkspace(db: Db, userId: string, account: ContextAccount, now: string): Promise<AccountWorkspace> {
  const day = strategyDay(now);
  const [observation, riskPlan, strategy, instruments, usage, plansOfDay] = await Promise.all([
    loadLatestObservation(db, userId, account.id),
    loadActiveRiskPlan(db, userId, account.id, day),
    db.from("strategy_versions").select("id,version,rules").eq("account_id", account.id).eq("user_id", userId).eq("version", "ICT V1.0").limit(1),
    db.from("instrument_versions").select(INSTRUMENT_SELECT).eq("account_id", account.id).eq("user_id", userId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }),
    loadDailyUsage(db, account.id),
    loadPlansOfDay(db, userId, account.id, day),
  ]);
  if (strategy.error || instruments.error) throw new Error("Account configuration unavailable.");
  // DUPLICATE reads the plans of the database's strategy day (usage.day), which differs from `day` only when this
  // request and the database straddle 00:00 UTC−5.
  const todaysPlans = usage.day === day ? plansOfDay : await loadPlansOfDay(db, userId, account.id, usage.day);
  const [strategyRecord] = z.array(strategyRow).parse(strategy.data ?? []);
  const latest = latestInstrumentVersions(parseInstrumentRows(instruments.data));
  const gaps: WorkspaceGap[] = [];
  if (!observation) gaps.push("ACCOUNT_VALUES");
  if (!riskPlan) gaps.push("RISK_PLAN");
  if (!strategyRecord) gaps.push("STRATEGY");
  if (!latest.length) gaps.push("INSTRUMENTS");
  const status = riskPlan
    ? dailyStatusV2({ now, observationDay: observation?.tradingDay ?? null, currency: account.currency, plan: riskPlan }, usage)
    : null;
  return {
    account, now, day, observation, riskPlan, strategy: strategyRecord ?? null, instruments: latest, usage, todaysPlans, status, gaps,
  };
}

/**
 * The engine context (spec §6.7) for one instrument of the workspace; null while the account lacks account values,
 * a risk plan, the strategy or that instrument. `instrument` may be any version of the account (a draft keeps the
 * version it was written with).
 *
 * `proposal` is the raw proposal the context will evaluate (Plan Trade / Edit Draft preview): `duplicate` is then
 * decided against the plans the account locked on the usage day, exactly as the server check decides it, so a preview
 * never shows "Ready" for a proposal the check blocks as DUPLICATE. Without a proposal (a context that only judges
 * whether a stored check is current) `duplicate` is false.
 */
export function riskContextFor(workspace: AccountWorkspace, instrument: Instrument | string, proposal: object | null = null): RiskContext | null {
  const contract = typeof instrument === "string" ? workspace.instruments.find(item => item.id === instrument.toLowerCase()) : instrument;
  const { observation, riskPlan, strategy } = workspace;
  if (!contract || !observation || !riskPlan || !strategy) return null;
  const plan: RiskPlan = {
    id: riskPlan.id, version: riskPlan.version, maxRiskPercent: riskPlan.maxRiskPercent, defaultRiskPercent: riskPlan.defaultRiskPercent,
    maxDailyTrades: riskPlan.maxDailyTrades, minRR: riskPlan.minRR, rrPolicy: riskPlan.rrPolicy, newsPolicy: riskPlan.newsPolicy,
    dailyRiskCap: riskPlan.dailyRiskCap, dailyLossCap: riskPlan.dailyLossCap,
  };
  return {
    now: workspace.now, strategyVersionId: strategy.id, strategyVersion: strategy.version, observationId: observation.id,
    observationDay: observation.tradingDay, equity: observation.equity, currency: workspace.account.currency, plan, instrument: contract,
    usage: workspace.usage, duplicate: proposal !== null && isDuplicatePlan(proposal, workspace.todaysPlans),
  };
}

/**
 * The instrument version a stored check was evaluated with: the given row when it is that version, else the version
 * among the workspace's latest instruments, else the self-describing instrument block of a report 1.2.
 */
function reportInstrument(workspace: AccountWorkspace, report: StoredRiskReport, known: Instrument | null): Instrument | null {
  if (!("reportVersion" in report)) return null;
  const id = report.snapshot.instrumentVersionId.toLowerCase();
  if (known && known.id.toLowerCase() === id) return known;
  const latest = workspace.instruments.find(item => item.id.toLowerCase() === id);
  if (latest) return latest;
  if (report.reportVersion !== "1.2") return null;
  const block = report.instrument;
  return {
    id: report.snapshot.instrumentVersionId, symbol: block.symbol, currency: block.currency, quantityUnit: block.quantityUnit, tickSize: block.tickSize,
    pipSize: block.pipSize, tickValue: block.tickValue, quantityStep: block.quantityStep, minimumQuantity: block.minimumQuantity,
  };
}

/**
 * Whether a stored APPROVED check is still current at the workspace's server time (spec §2.2, §6.4): same strategy
 * day, session, account values, risk plan, strategy, instrument version and daily usage. A draft keeps the contract
 * version it was written with (`instrument`, when known); the lock re-evaluates on the server regardless.
 */
export function isCheckCurrent(workspace: AccountWorkspace, report: StoredRiskReport, instrument: Instrument | null = null): boolean {
  const contract = reportInstrument(workspace, report, instrument);
  if (!contract || !workspace.observation) return false;
  const context = riskContextFor(workspace, contract);
  return context !== null && isRiskReportCurrent(report, context, workspace.observation.id, workspace.now);
}

export type WorkspaceView =
  | { mode: "account"; context: AccountContext; now: string; workspace: AccountWorkspace }
  /** All Accounts: one workspace per ACTIVE account (archived accounts take no new trades). */
  | { mode: "all"; context: AccountContext; now: string; workspaces: AccountWorkspace[] };

/** Workspaces of the request's account context, once per request. */
export const getWorkspace = cache(async (): Promise<WorkspaceView> => {
  const [{ db, user }, context] = await Promise.all([currentSession(), getAccountContext()]);
  const now = new Date().toISOString();
  if (context.selected.mode === "account") {
    return { mode: "account", context, now, workspace: await loadAccountWorkspace(db, user.id, context.selected.account, now) };
  }
  const workspaces = await Promise.all(context.active.map(account => loadAccountWorkspace(db, user.id, account, now)));
  return { mode: "all", context, now, workspaces };
});

/**
 * The workspace of one explicit account (Plan Trade / Record Live Trade / Edit Draft always name their account), or
 * null when the account is not the user's. Archived accounts load too (their pages stay readable).
 */
export const getAccountWorkspace = cache(async (accountId: string): Promise<AccountWorkspace | null> => {
  const { db, user } = await currentSession();
  const account = await loadAccount(db, user.id, accountId.toLowerCase());
  return account ? loadAccountWorkspace(db, user.id, account, new Date().toISOString()) : null;
});
