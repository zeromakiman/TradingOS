import "server-only";
import Decimal from "decimal.js";
import { cache } from "react";
import { z } from "zod";
import { accountDashboardHref } from "@/components/accounts/copy";
import { type AccountMetrics, accountCurrencyTotals, accountMetrics, type CurrencyTotals } from "@/domain/account-metrics";
import { formatDecimal, stripZeros } from "@/domain/format";
import type { LedgerTrade } from "@/domain/ledger";
import {
  breakdown, type CalendarMode, type CurvePoint, type DailyPoint, type DrawdownPoint, dailySeries, drawdownSeries, equityCurveR, isClosed,
} from "@/domain/performance";
import type { Instrument } from "@/domain/risk";
import { addDays, compareInstants, formatDay, strategyDay, strategyMonth } from "@/domain/time-display";
import { type AccountContext, type ContextAccount, currentSession, type Db, getAccountContext, loadAccount } from "./account-context";
import {
  breakdownHref, closedOnHref, type DrillDown, type LedgerRows, type LinkedBreakdownGroup, type LinkedCalendar, linkedCalendar, loadLedgerRows, MAX_LEDGER_ROWS,
  parseMonth,
} from "./performance-data";
import { type AccountConnectionState, loadAccountConnectionStates, type PlatformOption, platformOptions } from "./sync-service";
import { decorateTrades, journalHref, ledgerSelect, loadLedgerPage, parseLedger, type TradeListRow } from "./trades-data";
import {
  type AccountWorkspace, INSTRUMENT_SELECT, loadAccountWorkspace, OBSERVATION_SELECT, parseInstrumentRows, parseObservationRow, parseRiskPlanRow, RISK_PLAN_SELECT,
  toInstrument, type WorkspaceObservation, type WorkspaceRiskPlan,
} from "./workspace";

/**
 * Trading-account data (docs/V2_ARCHITECTURE.md §9.4, §14.7–14.9) with the user's session: the Accounts summary,
 * one account's dashboard and its Manage page. Money stays in each account's own currency; totals are grouped by
 * currency and never converted. Values that are not deterministically known stay null with a reason (never estimated).
 * Each account's trades are read on their own, up to the ledger read limit (`MAX_LEDGER_ROWS`): an account with more
 * has every figure computed from trades unknown (never a sum over part of them), and no other account is affected.
 */

const M = Decimal.clone({ precision: 100 });
const METRIC_LIFECYCLES = ["LIVE", "CLOSED", "REVIEWED"] as const;
const HISTORY_LIMIT = 30;

/**
 * Starting balance of every account: the latest profile's value, or for an account without a profile (created by
 * bootstrap_demo_account after migration 0015) the balance of its earliest observation, as update_account_profile
 * and the 0015 backfill define it.
 */
async function startingBalances(db: Db, userId: string, accounts: readonly ContextAccount[]): Promise<Map<string, string | null>> {
  const balances = new Map<string, string | null>(accounts.map(account => [account.id, account.startingBalance] as const));
  await Promise.all(accounts.filter(account => account.profile === "DEFAULT").map(async account => {
    const { data, error } = await db.from("account_observations").select("balance::text").eq("account_id", account.id).eq("user_id", userId)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).limit(1);
    if (error) throw new Error("Account values unavailable.");
    const [first] = z.array(z.object({ balance: z.string() })).parse(data ?? []);
    balances.set(account.id, first ? stripZeros(first.balance) : null);
  }));
  return balances;
}

async function latestObservations(db: Db, userId: string, accounts: readonly ContextAccount[]): Promise<Map<string, WorkspaceObservation | null>> {
  const entries = await Promise.all(accounts.map(async account => {
    const { data, error } = await db.from("account_observations").select(OBSERVATION_SELECT).eq("account_id", account.id).eq("user_id", userId)
      .order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (error) throw new Error("Account values unavailable.");
    const [row] = z.array(z.unknown()).parse(data ?? []);
    return [account.id, row === undefined ? null : parseObservationRow(row)] as const;
  }));
  return new Map(entries);
}

/**
 * The live, closed and reviewed trades of one account, `truncated` when it has more than `MAX_LEDGER_ROWS` (as the pages
 * say: "more than 20,000 trades"). The read allows one row more than that limit, so an account with exactly
 * `MAX_LEDGER_ROWS` trades is read in full and added up; one with more never is, even when the read held all of them.
 */
async function accountLedger(db: Db, userId: string, accountId: string): Promise<LedgerRows> {
  const ledger = await loadLedgerRows(db, userId, { mode: "account", accountId }, {}, { lifecycles: METRIC_LIFECYCLES, maxRows: MAX_LEDGER_ROWS + 1 });
  return { rows: ledger.rows, truncated: ledger.truncated || ledger.rows.length > MAX_LEDGER_ROWS };
}

function metricsOf(account: ContextAccount, startingBalance: string | null, observation: WorkspaceObservation | null, ledger: LedgerRows, now: string): AccountMetrics {
  return accountMetrics({
    account: { id: account.id, currency: account.currency },
    profile: { displayName: account.name, broker: account.broker, platform: account.platform, accountType: account.type, startingBalance, status: account.status },
    latestObservation: observation ? { balance: observation.balance, equity: observation.equity, tradingDay: observation.tradingDay, recordedAt: observation.recordedAt } : null,
    trades: ledger.rows,
    tradesComplete: !ledger.truncated,
    now,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Accounts summary (§14.7).
// ---------------------------------------------------------------------------------------------------------
export interface AccountSummary {
  account: ContextAccount;
  metrics: AccountMetrics;
  connection: AccountConnectionState;
  /** The dashboard; an active account's link also makes it the context (`accountDashboardHref`). */
  href: string;
  manageHref: string;
}

export interface AccountsOverview {
  context: AccountContext;
  now: string;
  active: AccountSummary[];
  /** Shown in a collapsed group. */
  archived: AccountSummary[];
  /** Active accounts' money per currency (never converted). */
  totals: CurrencyTotals[];
}

export async function loadAccountsOverview(db: Db, userId: string, context: AccountContext, now: string): Promise<AccountsOverview> {
  const accounts = context.accounts;
  // One read per account: a shared read would stop at the row limit somewhere among every account's trades.
  const [balances, observations, ledgers, connections] = await Promise.all([
    startingBalances(db, userId, accounts),
    latestObservations(db, userId, accounts),
    Promise.all(accounts.map(account => accountLedger(db, userId, account.id))),
    loadAccountConnectionStates(db, accounts.map(account => account.id)),
  ]);
  const summaries = accounts.map((account, index) => ({
    account,
    metrics: metricsOf(account, balances.get(account.id) ?? null, observations.get(account.id) ?? null, ledgers[index], now),
    connection: connections.get(account.id) ?? { mode: "MANUAL" as const, connection: null, lastSyncedAt: null, message: null },
    href: accountDashboardHref(account),
    manageHref: `/accounts/${account.id}/manage`,
  }));
  const active = summaries.filter(summary => summary.account.status === "ACTIVE");
  return {
    context, now, active, archived: summaries.filter(summary => summary.account.status === "ARCHIVED"),
    totals: accountCurrencyTotals(active.map(summary => summary.metrics)),
  };
}

export async function getAccountsOverview(): Promise<AccountsOverview> {
  const [{ db, user }, context] = await Promise.all([currentSession(), getAccountContext()]);
  return loadAccountsOverview(db, user.id, context, new Date().toISOString());
}

// ---------------------------------------------------------------------------------------------------------
// Risk plan versions with their status (§3.10 precedence, §14.9 labels).
// ---------------------------------------------------------------------------------------------------------
export type RiskPlanStatus = "ACTIVE" | "SCHEDULED" | "NEVER_EFFECTIVE" | "SUPERSEDED";

export interface RiskPlanVersionView extends WorkspaceRiskPlan {
  status: RiskPlanStatus;
  /** "Active", "Starts tomorrow", "Starts Oct 21", "Replaced before it started", "Replaced". */
  statusLabel: string;
  /** Null on legacy versions: the default equals the maximum (V1). */
  defaultEqualsMaximum: boolean;
}

/** First instant of a strategy day (the fixed UTC−5 clock of private.strategy_day). */
function strategyDayStart(day: string): string {
  return `${day}T05:00:00Z`;
}

/**
 * Status of every version on strategy day `today`, with private.active_risk_plan's rule applied at every instant: among
 * the versions that exist and whose day has begun, the newest created wins (`created_at desc, id desc`).
 *
 * A version can first govern a check at `start`, once it exists and its day has begun. If a newer version that existed
 * then, with its own day begun, outranks it at `start`, it outranks it at every later instant too (the versions in
 * effect only grow over time). Such a version never governed a check: "Replaced before it started", on every day
 * including after its own day has passed (V1 finding C9: an immediate tightening is not undone by an earlier-scheduled
 * loosening).
 * Any other version was in effect from `start` until a newer one took over. A past one is "Replaced", also when that
 * happened on its own first day: two immediate changes on one day, an immediate edit on the day an account was created,
 * or an immediate change on the day a scheduled version starts. A future one is "Starts tomorrow" or "Starts Oct 21".
 */
export function riskPlanTimeline(plans: readonly WorkspaceRiskPlan[], today: string): RiskPlanVersionView[] {
  const byCreation = [...plans].sort((a, b) => compareInstants(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const active = byCreation.find(plan => plan.effectiveDay <= today) ?? null;
  return byCreation.map((plan, index) => {
    const dayStart = strategyDayStart(plan.effectiveDay);
    const start = compareInstants(plan.createdAt, dayStart) > 0 ? plan.createdAt : dayStart;
    const startDay = strategyDay(start);
    // The versions before this one in `byCreation` are the newer ones.
    const neverEffective = byCreation.slice(0, index).some(newer => compareInstants(newer.createdAt, start) <= 0 && newer.effectiveDay <= startDay);
    let status: RiskPlanStatus;
    let statusLabel: string;
    if (active && plan.id === active.id) {
      status = "ACTIVE";
      statusLabel = "Active";
    } else if (neverEffective) {
      status = "NEVER_EFFECTIVE";
      statusLabel = "Replaced before it started";
    } else if (plan.effectiveDay > today) {
      status = "SCHEDULED";
      statusLabel = plan.effectiveDay === addDays(today, 1)
        ? "Starts tomorrow"
        : `Starts ${formatDay(plan.effectiveDay, undefined, { year: plan.effectiveDay.slice(0, 4) !== today.slice(0, 4) })}`;
    } else {
      status = "SUPERSEDED";
      statusLabel = "Replaced";
    }
    return { ...plan, status, statusLabel, defaultEqualsMaximum: plan.defaultRiskPercent === null };
  });
}

async function loadRiskPlans(db: Db, userId: string, accountId: string): Promise<WorkspaceRiskPlan[]> {
  const { data, error } = await db.from("risk_plan_versions").select(RISK_PLAN_SELECT).eq("account_id", accountId).eq("user_id", userId)
    .order("created_at", { ascending: false }).order("id", { ascending: false });
  if (error) throw new Error("Risk plans unavailable.");
  return z.array(z.unknown()).parse(data ?? []).map(parseRiskPlanRow);
}

// ---------------------------------------------------------------------------------------------------------
// Account dashboard (§14.8).
// ---------------------------------------------------------------------------------------------------------
export interface BalancePoint {
  sequence: number;
  tradeId: string | null;
  at: string | null;
  /** Starting balance + realized P&L after this exit, exact. */
  balance: string;
  /** Display-only chart value. */
  value: number;
}

export interface AccountDashboard {
  account: ContextAccount;
  now: string;
  metrics: AccountMetrics;
  connection: AccountConnectionState;
  workspace: AccountWorkspace;
  /** "Balance from trades" line in the account currency; null without a starting balance (never estimated). */
  balanceCurve: BalancePoint[] | null;
  curve: CurvePoint[];
  drawdown: DrawdownPoint[];
  daily: (DailyPoint & { href: string })[];
  calendar: LinkedCalendar;
  recentTrades: TradeListRow[];
  liveTrades: TradeListRow[];
  breakdowns: { model: LinkedBreakdownGroup[]; session: LinkedBreakdownGroup[] };
  riskPlans: RiskPlanVersionView[];
  links: { journal: string; edge: string; manage: string };
  /**
   * The account has more live and closed trades than one read holds (`MAX_LEDGER_ROWS`). The metrics computed from
   * trades are then unknown (`metrics.tradesUnknown`), and the balance line, R curve, drawdown, daily series, calendar
   * and breakdowns are left empty: none of them is ever drawn from part of the trades. Recent and live trades are
   * separate reads and stay listed.
   */
  truncated: boolean;
}

/** Starting balance plus cumulative net P&L in exit order (microsecond-exact, id tie-break). */
export function balanceCurve(startingBalance: string | null, trades: readonly LedgerTrade[]): BalancePoint[] | null {
  if (startingBalance === null) return null;
  const closed = trades.filter(trade => isClosed(trade) && trade.net_pnl !== null)
    .sort((a, b) => compareInstants(a.exited_at as string, b.exited_at as string) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let balance = new M(startingBalance);
  const points: BalancePoint[] = [{ sequence: 0, tradeId: null, at: null, balance: balance.toFixed(), value: balance.toNumber() }];
  closed.forEach((trade, index) => {
    balance = balance.plus(trade.net_pnl as string);
    points.push({ sequence: index + 1, tradeId: trade.id, at: trade.exited_at, balance: balance.toFixed(), value: balance.toNumber() });
  });
  return points;
}

export interface DashboardOptions {
  month?: string;
  calendarMode?: CalendarMode;
}

export async function loadAccountDashboard(db: Db, userId: string, context: AccountContext, account: ContextAccount, now: string, options: DashboardOptions = {}): Promise<AccountDashboard> {
  const scope = { mode: "account" as const, accountId: account.id };
  const [balances, observations, ledger, connections, workspace, riskPlans, recent, live] = await Promise.all([
    startingBalances(db, userId, [account]),
    latestObservations(db, userId, [account]),
    accountLedger(db, userId, account.id),
    loadAccountConnectionStates(db, [account.id]),
    loadAccountWorkspace(db, userId, account, now),
    loadRiskPlans(db, userId, account.id),
    loadLedgerPage(db, userId, scope, {}, null, 10),
    ledgerSelect(db).eq("account_id", account.id).eq("lifecycle", "LIVE").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50),
  ]);
  if (live.error) throw new Error("Trades are unavailable.");
  const workspaces = new Map([[account.id, workspace] as const]);
  const listDeps = { db, userId, accounts: context.accounts, now, workspaces };
  const [recentTrades, liveTrades] = await Promise.all([decorateTrades(listDeps, recent.rows), decorateTrades(listDeps, parseLedger(live.data))]);
  const startingBalance = balances.get(account.id) ?? null;
  // Part of an account's trades (an arbitrary part: the read pages by id) never feeds a chart.
  const closed = ledger.truncated ? [] : ledger.rows.filter(isClosed);
  const drill: DrillDown = { base: {}, account: account.id };
  const names = { [account.id]: account.name };
  return {
    account,
    now,
    metrics: metricsOf(account, startingBalance, observations.get(account.id) ?? null, ledger, now),
    connection: connections.get(account.id) ?? { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null },
    workspace,
    balanceCurve: balanceCurve(startingBalance, closed),
    curve: equityCurveR(closed),
    drawdown: drawdownSeries(closed),
    daily: dailySeries(closed).map(point => ({ ...point, href: closedOnHref(point.day, drill) })),
    calendar: linkedCalendar(closed, parseMonth(options.month, strategyMonth(now)), options.calendarMode ?? "NET_R", drill),
    recentTrades,
    liveTrades,
    breakdowns: {
      model: breakdown(closed, "model", { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) })),
      session: breakdown(closed, "session", { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) })),
    },
    riskPlans: riskPlanTimeline(riskPlans, strategyDay(now)),
    links: { journal: journalHref({}, { account: account.id }), edge: `/edge?account=${account.id}`, manage: `/accounts/${account.id}/manage` },
    truncated: ledger.truncated,
  };
}

/** One account's dashboard, or null when the account is not the user's (pages call notFound()). Archived accounts load. */
export const getAccountDashboard = cache(async (accountId: string, month?: string, calendarMode?: CalendarMode): Promise<AccountDashboard | null> => {
  const [{ db, user }, context] = await Promise.all([currentSession(), getAccountContext()]);
  const account = context.accounts.find(item => item.id === accountId.toLowerCase()) ?? (await loadAccount(db, user.id, accountId.toLowerCase()));
  if (!account) return null;
  return loadAccountDashboard(db, user.id, context, account, new Date().toISOString(), { month, calendarMode });
});

// ---------------------------------------------------------------------------------------------------------
// Manage account (§14.9).
// ---------------------------------------------------------------------------------------------------------
export interface ProfileRevisionView {
  recordedAt: string;
  name: string;
  broker: string | null;
  platform: string;
  type: string;
  startingBalance: string | null;
  status: "ACTIVE" | "ARCHIVED";
  /** USER edits or the MIGRATION backfill. */
  source: "USER" | "MIGRATION";
}

export interface ExternalLossView {
  /** Handle for the remove form. */
  id: string;
  tradingDay: string;
  amount: string;
  note: string | null;
  recordedAt: string;
  removedAt: string | null;
  removalReason: string | null;
}

export interface InstrumentVersionView extends Instrument {
  createdAt: string;
  /** The newest version of its symbol: offered in pickers. Older versions stay attached to history. */
  current: boolean;
}

export interface AccountManage {
  account: ContextAccount;
  now: string;
  /** Strategy day of `now`. */
  day: string;
  startingBalance: string | null;
  profileHistory: ProfileRevisionView[];
  values: { latest: WorkspaceObservation | null; confirmedToday: boolean; history: WorkspaceObservation[] };
  externalLosses: { today: ExternalLossView[]; recent: ExternalLossView[]; todayTotal: string };
  riskPlans: RiskPlanVersionView[];
  activeRiskPlan: RiskPlanVersionView | null;
  strategy: { version: string; minimumRR: string | null; warning: string | null } | null;
  instruments: InstrumentVersionView[];
  connection: AccountConnectionState;
  platformOptions: PlatformOption[];
  archived: boolean;
}

const profileHistoryRow = z.object({
  display_name: z.string(), broker: z.string().nullable(), platform: z.string(), account_type: z.string(), starting_balance: z.string().nullable(),
  status: z.enum(["ACTIVE", "ARCHIVED"]), source: z.enum(["USER", "MIGRATION"]), recorded_at: z.string(),
});
const lossRow = z.object({ id: z.uuid(), trading_day: z.string(), amount: z.string(), note: z.string().nullable(), recorded_at: z.string() });
const lossRemovalRow = z.object({ entry_id: z.uuid(), reason: z.string().nullable(), recorded_at: z.string() });
const strategyRulesRow = z.object({ version: z.string(), rules: z.record(z.string(), z.unknown()) });

/** Warning when the risk plan accepts a lower RR than the strategy documents (spec §14.9). */
export function minimumRrWarning(planMinRR: string | null, strategyMinimum: string | null): string | null {
  if (planMinRR === null || strategyMinimum === null) return null;
  if (!new M(planMinRR).lt(strategyMinimum)) return null;
  return `Your risk plan's minimum RR of ${formatDecimal(planMinRR)}R is below the strategy's documented ${formatDecimal(strategyMinimum)}R.`;
}

export async function loadAccountManage(db: Db, userId: string, account: ContextAccount, now: string): Promise<AccountManage> {
  const day = strategyDay(now);
  const [balances, profiles, observations, losses, riskPlans, strategy, instruments, connections] = await Promise.all([
    startingBalances(db, userId, [account]),
    db.from("account_profiles").select("display_name,broker,platform,account_type,starting_balance::text,status,source,recorded_at").eq("account_id", account.id).eq("user_id", userId)
      .order("id", { ascending: false }).limit(HISTORY_LIMIT),
    db.from("account_observations").select(OBSERVATION_SELECT).eq("account_id", account.id).eq("user_id", userId)
      .order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(HISTORY_LIMIT),
    db.from("external_loss_entries").select("id,trading_day,amount::text,note,recorded_at").eq("account_id", account.id).eq("user_id", userId)
      .order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(HISTORY_LIMIT),
    loadRiskPlans(db, userId, account.id),
    db.from("strategy_versions").select("version,rules").eq("account_id", account.id).eq("user_id", userId).eq("version", "ICT V1.0").limit(1),
    db.from("instrument_versions").select(INSTRUMENT_SELECT).eq("account_id", account.id).eq("user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }),
    loadAccountConnectionStates(db, [account.id]),
  ]);
  if (profiles.error || observations.error || losses.error || strategy.error || instruments.error) throw new Error("Account records are unavailable.");
  const lossRows = z.array(lossRow).parse(losses.data ?? []);
  const removals = lossRows.length
    ? await db.from("external_loss_removals").select("entry_id,reason,recorded_at").eq("user_id", userId).in("entry_id", lossRows.map(row => row.id))
    : { data: [], error: null };
  if (removals.error) throw new Error("Account records are unavailable.");
  const removedBy = new Map(z.array(lossRemovalRow).parse(removals.data ?? []).map(row => [row.entry_id, row] as const));
  const lossViews: ExternalLossView[] = lossRows.map(row => ({
    id: row.id, tradingDay: row.trading_day, amount: stripZeros(row.amount), note: row.note, recordedAt: row.recorded_at,
    removedAt: removedBy.get(row.id)?.recorded_at ?? null, removalReason: removedBy.get(row.id)?.reason ?? null,
  }));
  const today = lossViews.filter(loss => loss.tradingDay === day);
  const history = z.array(z.unknown()).parse(observations.data ?? []).map(parseObservationRow);
  const plans = riskPlanTimeline(riskPlans, day);
  const activeRiskPlan = plans.find(plan => plan.status === "ACTIVE") ?? null;
  const [strategyRecord] = z.array(strategyRulesRow).parse(strategy.data ?? []);
  const minimum = strategyRecord ? z.union([z.string(), z.number()]).safeParse(strategyRecord.rules.minimum_rr) : null;
  const strategyMinimum = minimum?.success ? stripZeros(String(minimum.data)) : null;
  const seen = new Set<string>();
  const instrumentViews = parseInstrumentRows(instruments.data).map(row => {
    const current = !seen.has(row.symbol);
    seen.add(row.symbol);
    return { ...toInstrument(row), createdAt: row.created_at, current };
  });
  return {
    account,
    now,
    day,
    startingBalance: balances.get(account.id) ?? null,
    profileHistory: z.array(profileHistoryRow).parse(profiles.data ?? []).map(row => ({
      recordedAt: row.recorded_at, name: row.display_name, broker: row.broker, platform: row.platform, type: row.account_type,
      startingBalance: row.starting_balance === null ? null : stripZeros(row.starting_balance), status: row.status, source: row.source,
    })),
    values: { latest: history[0] ?? null, confirmedToday: history[0]?.tradingDay === day, history },
    externalLosses: {
      today, recent: lossViews,
      todayTotal: today.filter(loss => loss.removedAt === null).reduce((total, loss) => total.plus(loss.amount), new M(0)).toFixed(),
    },
    riskPlans: plans,
    activeRiskPlan,
    strategy: strategyRecord ? { version: strategyRecord.version, minimumRR: strategyMinimum, warning: minimumRrWarning(activeRiskPlan?.minRR ?? null, strategyMinimum) } : null,
    instruments: instrumentViews,
    connection: connections.get(account.id) ?? { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null },
    platformOptions: platformOptions(),
    archived: account.status === "ARCHIVED",
  };
}

/** The Manage page of one account, or null when it is not the user's. */
export const getAccountManage = cache(async (accountId: string): Promise<AccountManage | null> => {
  const { db, user } = await currentSession();
  const account = await loadAccount(db, user.id, accountId.toLowerCase());
  return account ? loadAccountManage(db, user.id, account, new Date().toISOString()) : null;
});
