import "server-only";
import { z } from "zod";
import type { Instrument } from "@/domain/risk";
import { type ExplainLookup, explainReport } from "@/domain/risk-explain";
import { storedRiskSchema } from "@/domain/risk-report";
import { strategyDayLabel } from "@/domain/time-display";
import { type BlockingFinding, blockingFindingsOf, reasonWithCount, withBlockingFindings } from "@/domain/trade-state";
import { currentSession, type Db, getAccountContext, getPreferences } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { getToday, type TodayData } from "@/lib/today-data";
import { inBatches, type TradeListRow } from "@/lib/trades-data";
import { INSTRUMENT_SELECT, parseInstrumentRows, parseRiskPlanRow, RISK_PLAN_SELECT, toInstrument } from "@/lib/workspace";
import { type LiveManagement, MANAGEMENT_COLUMNS, MANAGEMENT_KINDS, type ManagementRow, managementRow, summarizeManagement } from "./management";
import type { TodayPage } from "./types";
import { buildTodayView } from "./view-model";

/**
 * Loads Today (docs/V2_ARCHITECTURE.md §14.1) for one request: the account context (first run → onboarding; only
 * archived accounts → a restore prompt), `getToday()` of the data layer, the display preferences, and the details the
 * screen needs beyond `TodayData`: the exact instrument version of every listed trade (prices at their tick scale),
 * the first blocking reason of each blocked draft with how many more its check found, explained from its stored check
 * with the immutable rows of its own risk plan, instrument and strategy versions (spec §6.5, §10), the next action of a
 * draft blocked today only by what no edit clears (as its trade page leads with it), and how each live position was
 * managed (stop moves and partial closes journaled while it was live, §3.6). All are read with the user's session; when
 * one cannot be read the screen still renders (prices exact, reasons on the trade page, the initial stop labelled as such).
 */

const evaluationRow = z.object({
  id: z.uuid(),
  result: z.unknown(),
  proposal: z.record(z.string(), z.unknown()),
  risk_plan_version_id: z.uuid().nullable(),
  instrument_version_id: z.uuid().nullable(),
  strategy_version_id: z.uuid().nullable(),
});
const strategyRow = z.object({ id: z.uuid(), version: z.string() });
const proposalFields = z.object({ direction: z.enum(["LONG", "SHORT"]), riskPercent: z.string() }).partial();

export interface TodayExtras {
  instruments: Map<string, Instrument>;
  /** The first blocking reason of each blocked draft's latest check, with ` (+N more)` when it found more. */
  blockingReasons: Map<string, string>;
  /**
   * The blocking findings of each blocked draft's latest check (with the room its daily caps had left, and whether its
   * account has confirmed today's values since), by trade id.
   */
  blockingFindings: Map<string, BlockingFinding[]>;
}

interface Result {
  data: unknown;
  error: unknown;
}

function rowsOf(results: readonly Result[]): unknown[] {
  if (results.some(result => result.error)) throw new Error("Today's details are unavailable.");
  return results.flatMap(result => (Array.isArray(result.data) ? result.data : []));
}

/** Every trade Today lists (live, plans waiting, closed today). */
export function listedRows(data: TodayData): TradeListRow[] {
  const { plans } = data;
  return [...data.live.map(card => card.row), ...plans.locked, ...plans.ready, ...plans.recheck, ...plans.blocked, ...plans.unchecked, ...data.closedToday];
}

export async function loadTodayExtras(db: Db, userId: string, data: TodayData): Promise<TodayExtras> {
  const blocked = data.plans.blocked.filter(row => row.trade.latest_check_evaluation_id !== null);
  const evaluationIds = [...new Set(blocked.map(row => row.trade.latest_check_evaluation_id as string))];
  const evaluations = evaluationIds.length
    ? z.array(evaluationRow).parse(rowsOf(await Promise.all(inBatches(evaluationIds).map(batch => db.from("risk_evaluations")
      .select("id,result,proposal,risk_plan_version_id,instrument_version_id,strategy_version_id").eq("user_id", userId).in("id", batch)))))
    : [];
  const reports = new Map(evaluations.map(row => [row.id, { row, parsed: storedRiskSchema.safeParse(row.result) }] as const));
  // Reports 1.2 carry every value of their sentences; 1.1 and legacy reports need the rows of their own versions.
  const older = evaluations.filter(row => {
    const parsed = reports.get(row.id)?.parsed;
    return parsed?.success === true && !("reportVersion" in parsed.data && parsed.data.reportVersion === "1.2");
  });
  const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))];
  const instrumentIds = unique([...listedRows(data).map(row => row.trade.instrument_version_id), ...older.map(row => row.instrument_version_id)]);
  const riskPlanIds = unique(older.map(row => row.risk_plan_version_id));
  const strategyIds = unique(older.map(row => row.strategy_version_id));
  const [instrumentResults, riskPlanResults, strategyResults] = await Promise.all([
    Promise.all(inBatches(instrumentIds).map(batch => db.from("instrument_versions").select(INSTRUMENT_SELECT).eq("user_id", userId).in("id", batch))),
    Promise.all(inBatches(riskPlanIds).map(batch => db.from("risk_plan_versions").select(RISK_PLAN_SELECT).eq("user_id", userId).in("id", batch))),
    Promise.all(inBatches(strategyIds).map(batch => db.from("strategy_versions").select("id,version").eq("user_id", userId).in("id", batch))),
  ]);
  const instruments = new Map(parseInstrumentRows(rowsOf(instrumentResults)).map(row => [row.id, toInstrument(row)] as const));
  const riskPlans = new Map(rowsOf(riskPlanResults).map(parseRiskPlanRow).map(plan => [plan.id, plan] as const));
  const strategies = new Map(z.array(strategyRow).parse(rowsOf(strategyResults)).map(row => [row.id, row.version] as const));

  // Accounts whose latest values are from today: a stale-values block of theirs needs only the recheck now.
  const valuesToday = new Set(data.accounts.filter(status => status.workspace.observation?.tradingDay === status.workspace.day).map(status => status.account.id));
  const blockingReasons = new Map<string, string>();
  const blockingFindings = new Map<string, BlockingFinding[]>();
  for (const row of blocked) {
    const entry = reports.get(row.trade.latest_check_evaluation_id as string);
    if (!entry?.parsed.success) continue;
    const report = entry.parsed.data;
    const evaluation = entry.row;
    const riskPlan = evaluation.risk_plan_version_id ? riskPlans.get(evaluation.risk_plan_version_id) : undefined;
    const contract = evaluation.instrument_version_id ? instruments.get(evaluation.instrument_version_id) : undefined;
    const fields = proposalFields.safeParse(evaluation.proposal);
    const lookup: ExplainLookup = {
      riskPlan: riskPlan ? {
        id: riskPlan.id, maxRiskPercent: riskPlan.maxRiskPercent, minRR: riskPlan.minRR, dailyRiskCap: riskPlan.dailyRiskCap, dailyLossCap: riskPlan.dailyLossCap,
        rrPolicy: riskPlan.rrPolicy, newsPolicy: riskPlan.newsPolicy, maxDailyTrades: riskPlan.maxDailyTrades,
      } : undefined,
      instrument: contract ? {
        id: contract.id, symbol: contract.symbol, currency: contract.currency, tickSize: contract.tickSize, minimumQuantity: contract.minimumQuantity,
        quantityUnit: contract.quantityUnit, quantityStep: contract.quantityStep,
      } : undefined,
      proposal: fields.success ? fields.data : undefined,
      strategy: evaluation.strategy_version_id ? strategies.get(evaluation.strategy_version_id) : undefined,
      accountCurrency: row.account.currency,
    };
    const blocking = explainReport(report, lookup).blocking;
    const reason = reasonWithCount(blocking);
    if (reason) blockingReasons.set(row.id, reason);
    const v12 = "reportVersion" in report && report.reportVersion === "1.2" ? report : null;
    blockingFindings.set(row.id, blockingFindingsOf(blocking.map(issue => issue.code), v12, { valuesConfirmedToday: valuesToday.has(row.account.id) }));
  }
  return { instruments, blockingReasons, blockingFindings };
}

const NO_EXTRAS: TodayExtras = { instruments: new Map(), blockingReasons: new Map(), blockingFindings: new Map() };

/**
 * Today's data with each blocked draft led as its trade page leads it (`withBlockingFindings`, §2.4, §6.3): a draft
 * blocked today only by what no edit clears (Dead Pool, a used-up daily limit, today's account values) offers the step
 * that does, Edit draft beside it. Drafts without known findings keep their state.
 */
export function withBlockedPlanActions(data: TodayData, findings: ReadonlyMap<string, readonly BlockingFinding[]>): TodayData {
  if (findings.size === 0) return data;
  const blocked = data.plans.blocked.map(row => {
    const found = findings.get(row.id);
    return found ? { ...row, state: withBlockingFindings(row.state, found) } : row;
  });
  return { ...data, plans: { ...data.plans, blocked } };
}

/** Journal rows read per request while collecting the live trades' stop moves and partial closes. */
const MANAGEMENT_PAGE = 500;

/** Keyset position: rows strictly older than (`recordedAt`, `id`) in newest-first order. */
function olderThan(after: { recordedAt: string; id: string }): string {
  // Values are double-quoted so PostgREST never reads the timestamp's punctuation as filter syntax.
  return `recorded_at.lt."${after.recordedAt}",and(recorded_at.eq."${after.recordedAt}",id.lt."${after.id}")`;
}

/**
 * Every stop move and partial close of the live trades, exactly: newest first in pages, each continuing after the last
 * row of the previous one (keyset), so none is skipped or read twice. Each row comes with its stored phase, so only
 * what was journaled while the position was live describes it (`summarizeManagement`).
 */
export async function loadLiveManagement(db: Db, userId: string, data: TodayData): Promise<Map<string, LiveManagement>> {
  const tradeIds = [...new Set(data.live.map(card => card.row.id))];
  if (!tradeIds.length) return new Map();
  const rows: ManagementRow[] = [];
  await Promise.all(inBatches(tradeIds).map(async batch => {
    let after: { recordedAt: string; id: string } | null = null;
    for (;;) {
      let query = db.from("trade_journal_entries").select(MANAGEMENT_COLUMNS).eq("user_id", userId).in("trade_id", batch)
        .in("kind", [...MANAGEMENT_KINDS]);
      if (after) query = query.or(olderThan(after));
      const { data: page, error } = await query.order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(MANAGEMENT_PAGE);
      if (error) throw new Error("Live trade management is unavailable.");
      const parsed = z.array(managementRow).parse(page ?? []);
      rows.push(...parsed);
      if (parsed.length < MANAGEMENT_PAGE) return;
      const last = parsed[parsed.length - 1];
      after = { recordedAt: last.recorded_at, id: last.id };
    }
  }));
  return summarizeManagement(rows);
}

/** Today of the request's account context. */
export async function loadTodayPage(): Promise<TodayPage> {
  const context = await getAccountContext();
  const dayLabel = strategyDayLabel(new Date());
  if (context.accounts.length === 0) return { kind: "onboarding", dayLabel };
  if (context.active.length === 0) return { kind: "no-active", dayLabel, archivedCount: context.archived.length };
  const [{ db, user }, data, preferences] = await Promise.all([currentSession(), getToday(), getPreferences()]);
  // Instrument scales, blocking sentences and stop moves refine the screen; without them it still renders exact values.
  const [extras, management] = await Promise.all([
    loadTodayExtras(db, user.id, data).catch(() => {
      operationalFailure("data_read_failed");
      return NO_EXTRAS;
    }),
    loadLiveManagement(db, user.id, data).catch(() => {
      operationalFailure("data_read_failed");
      return new Map<string, LiveManagement>();
    }),
  ]);
  return {
    kind: "today",
    view: buildTodayView({
      data: withBlockedPlanActions(data, extras.blockingFindings), display: preferences.timeDisplay, instruments: extras.instruments,
      blockingReasons: extras.blockingReasons, management, requestKey: () => crypto.randomUUID(),
    }),
  };
}
