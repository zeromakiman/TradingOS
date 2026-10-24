import "server-only";
import { z } from "zod";
import type { Instrument } from "@/domain/risk";
import { type ExplainLookup, explainReport } from "@/domain/risk-explain";
import { storedRiskSchema } from "@/domain/risk-report";
import { strategyDayLabel } from "@/domain/time-display";
import { currentSession, type Db, getAccountContext, getPreferences } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { getToday, type TodayData } from "@/lib/today-data";
import { inBatches, type TradeListRow } from "@/lib/trades-data";
import { INSTRUMENT_SELECT, parseInstrumentRows, parseRiskPlanRow, RISK_PLAN_SELECT, toInstrument } from "@/lib/workspace";
import { type LiveManagement, MANAGEMENT_KINDS, type ManagementRow, managementRow, summarizeManagement } from "./management";
import type { TodayPage } from "./types";
import { buildTodayView } from "./view-model";

/**
 * Loads Today (docs/V2_ARCHITECTURE.md §14.1) for one request: the account context (first run → onboarding; only
 * archived accounts → a restore prompt), `getToday()` of the data layer, the display preferences, and the details the
 * screen needs beyond `TodayData`: the exact instrument version of every listed trade (prices at their tick scale),
 * the first blocking reason of each blocked draft, explained from its stored check with the immutable rows of its own
 * risk plan, instrument and strategy versions (spec §6.5), and how each live position was managed (stop moves and
 * partial closes from its journal, §3.6). All are read with the user's session; when one cannot be read the screen
 * still renders (prices exact, reasons on the trade page, the initial stop labelled as such).
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
  blockingReasons: Map<string, string>;
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

  const blockingReasons = new Map<string, string>();
  for (const row of blocked) {
    const entry = reports.get(row.trade.latest_check_evaluation_id as string);
    if (!entry?.parsed.success) continue;
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
    const first = explainReport(entry.parsed.data, lookup).blocking[0]?.detail;
    if (first) blockingReasons.set(row.id, first);
  }
  return { instruments, blockingReasons };
}

const NO_EXTRAS: TodayExtras = { instruments: new Map(), blockingReasons: new Map() };

/** Journal rows read per request while collecting the live trades' stop moves and partial closes. */
const MANAGEMENT_PAGE = 500;

/** Keyset position: rows strictly older than (`recordedAt`, `id`) in newest-first order. */
function olderThan(after: { recordedAt: string; id: string }): string {
  // Values are double-quoted so PostgREST never reads the timestamp's punctuation as filter syntax.
  return `recorded_at.lt."${after.recordedAt}",and(recorded_at.eq."${after.recordedAt}",id.lt."${after.id}")`;
}

/**
 * Every stop move and partial close of the live trades, exactly: newest first in pages, each continuing after the last
 * row of the previous one (keyset), so none is skipped or read twice.
 */
export async function loadLiveManagement(db: Db, userId: string, data: TodayData): Promise<Map<string, LiveManagement>> {
  const tradeIds = [...new Set(data.live.map(card => card.row.id))];
  if (!tradeIds.length) return new Map();
  const rows: ManagementRow[] = [];
  await Promise.all(inBatches(tradeIds).map(async batch => {
    let after: { recordedAt: string; id: string } | null = null;
    for (;;) {
      let query = db.from("trade_journal_entries").select("id,trade_id,kind,details,recorded_at").eq("user_id", userId).in("trade_id", batch)
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
      data, display: preferences.timeDisplay, instruments: extras.instruments, blockingReasons: extras.blockingReasons, management, requestKey: () => crypto.randomUUID(),
    }),
  };
}
