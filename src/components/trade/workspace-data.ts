import "server-only";
import Decimal from "decimal.js";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { type StrategyCard, strategyCard } from "@/domain/strategy-card";
import { currentSession } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import type { ProposalView, TradeDetail } from "@/lib/trades-data";
import { type AccountWorkspace, getAccountWorkspace, parseRiskPlanRow, RISK_PLAN_SELECT, type WorkspaceRiskPlan } from "@/lib/workspace";
import type { LockUsage, PositionDetail, PositionRecord } from "./model";

/**
 * What the trade workspace needs beyond `getTradeDetail` (docs/V2_ARCHITECTURE.md §3.5, §8.1, §8.2, §12.1):
 * - the strategy card: the account's current strategy and active risk plan for a draft, the locked versions for a plan;
 * - today's usage of the account, so the lock confirmation can say what locking reserves;
 * - the account's contract for a live-first symbol recorded without one ("Add entry details");
 * - which entry details of a live-first or imported position each of its records set, so the page can say which were
 *   completed later and when (the trade detail carries these records in words only);
 * - the last revision of a draft that never became a plan (discarded, or skipped in V1), whose values and thesis stay
 *   readable on its page.
 * Everything is read with the user's session. A failed read degrades to empty extras (the page still works and the
 * server still decides every check); it never blocks the trade page.
 */

export interface InstrumentOption {
  id: string;
  /** `DE40 · tick 0.1 · contracts`. */
  label: string;
}

export interface TradeExtras {
  /** The strategy card and which versions it shows, in words. */
  strategy: { context: string; card: StrategyCard } | null;
  lockUsage: LockUsage | null;
  instruments: InstrumentOption[];
  lastProposal: ProposalView | null;
  /** Records of a live-first or imported position's entry details, oldest first; empty for planned trades. */
  positionRecords: PositionRecord[];
}

export const EMPTY_EXTRAS: TradeExtras = Object.freeze({ strategy: null, lockUsage: null, instruments: [], lastProposal: null, positionRecords: [] });
const D = Decimal.clone({ precision: 60 });

const strategyRow = z.object({ id: z.uuid(), version: z.string(), rules: z.unknown() });
const proposalRow = z.object({ id: z.uuid(), proposal: z.record(z.string(), z.unknown()), instrument_version_id: z.uuid().nullable() });
const proposalFields = z.object({
  direction: z.enum(["LONG", "SHORT"]), model: z.enum(["OB_FIRST_TOUCH", "OTE"]), entry: z.string(), stop: z.string().nullable(), target: z.string(),
  riskPercent: z.string(), narrative: z.string(), contractConfirmed: z.boolean(), news: z.enum(["UNKNOWN", "CLEAR", "RESTRICTED"]), contradiction: z.boolean(),
}).partial();

const positionRow = z.object({
  recorded_at: z.string(), instrument_version_id: z.uuid().nullable(), entry_model: z.string().nullable(), entry_price: z.string().nullable(),
  entered_at: z.string().nullable(), quantity: z.string().nullable(), initial_stop: z.string().nullable(), risk_amount: z.string().nullable(),
});
type PositionRow = z.infer<typeof positionRow>;
const POSITION_COLUMNS: readonly (readonly [PositionDetail, keyof PositionRow])[] = [
  ["contract", "instrument_version_id"], ["model", "entry_model"], ["entryPrice", "entry_price"], ["enteredAt", "entered_at"], ["quantity", "quantity"],
  ["initialStop", "initial_stop"], ["riskAmount", "risk_amount"],
];

const DRAFT_CONTEXT = "The strategy and the risk plan this draft is checked against today.";
const LOCKED_CONTEXT = "The strategy and risk plan versions this plan was locked with. Later versions don't change it.";

function cardOf(rules: unknown, riskPlan: WorkspaceRiskPlan, currency: string, context: string): NonNullable<TradeExtras["strategy"]> {
  return {
    context,
    card: strategyCard(rules, {
      version: riskPlan.version, maxRiskPercent: riskPlan.maxRiskPercent, defaultRiskPercent: riskPlan.defaultRiskPercent, minRR: riskPlan.minRR,
      rrPolicy: riskPlan.rrPolicy, newsPolicy: riskPlan.newsPolicy, maxDailyTrades: riskPlan.maxDailyTrades, dailyRiskCap: riskPlan.dailyRiskCap,
      dailyLossCap: riskPlan.dailyLossCap, currency,
    }),
  };
}

/** The versions a locked plan was checked with (immutable rows), as a strategy card. */
async function lockedStrategy(detail: TradeDetail): Promise<TradeExtras["strategy"]> {
  const { strategyVersionId, riskPlanVersionId } = detail.technical;
  if (!strategyVersionId || !riskPlanVersionId) return null;
  const { db, user } = await currentSession();
  const [strategy, riskPlan] = await Promise.all([
    db.from("strategy_versions").select("id,version,rules").eq("id", strategyVersionId).eq("user_id", user.id).maybeSingle(),
    db.from("risk_plan_versions").select(RISK_PLAN_SELECT).eq("id", riskPlanVersionId).eq("user_id", user.id).maybeSingle(),
  ]);
  if (strategy.error || riskPlan.error) throw new Error("Strategy versions unavailable");
  if (!strategy.data || !riskPlan.data) return null;
  const row = strategyRow.parse(strategy.data);
  return cardOf(row.rules, parseRiskPlanRow(riskPlan.data), detail.account.currency, LOCKED_CONTEXT);
}

/** The latest revision's proposal of a draft that was never locked, in the shape of `TradeDetail.draft.proposal`. */
async function latestProposal(detail: TradeDetail): Promise<ProposalView | null> {
  const proposalId = detail.technical.latestProposalId;
  if (!proposalId) return null;
  const { db, user } = await currentSession();
  const { data, error } = await db.from("setup_proposals").select("id,proposal,instrument_version_id").eq("id", proposalId).eq("user_id", user.id).maybeSingle();
  if (error) throw new Error("Draft revision unavailable");
  if (!data) return null;
  const row = proposalRow.parse(data);
  const parsed = proposalFields.safeParse(row.proposal);
  const p = parsed.success ? parsed.data : {};
  return {
    instrumentVersionId: row.instrument_version_id, direction: p.direction ?? null, model: p.model ?? null, entry: p.entry ?? null, stop: p.stop ?? null,
    target: p.target ?? null, riskPercent: p.riskPercent ?? null, narrative: p.narrative ?? null, contractConfirmed: p.contractConfirmed ?? null,
    news: p.news ?? null, contradiction: p.contradiction ?? null,
  };
}

/** The entry-detail records of a live-first or imported position, oldest first, each with the details it set (§3.5). */
async function positionRecords(detail: TradeDetail): Promise<PositionRecord[]> {
  const { db, user } = await currentSession();
  const { data, error } = await db.from("trade_position_facts")
    .select("recorded_at,instrument_version_id,entry_model,entry_price::text,entered_at,quantity::text,initial_stop::text,risk_amount::text")
    .eq("trade_id", detail.tradeId).eq("user_id", user.id).order("recorded_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error("Entry details unavailable");
  return z.array(positionRow).parse(data ?? []).map(row => ({
    recordedAt: row.recorded_at,
    details: POSITION_COLUMNS.filter(([, column]) => row[column] !== null).map(([field]) => field),
  }));
}

function lockUsageOf(workspace: AccountWorkspace): LockUsage | null {
  const plan = workspace.riskPlan;
  if (!plan) return null;
  const usage = workspace.usage;
  return {
    slotsUsed: usage.plannedSlots + usage.unplannedTrades,
    maxDailyTrades: plan.maxDailyTrades,
    // Exact sum of the canonical decimal strings of `get_daily_risk_usage` (never floating point).
    riskUsed: new D(usage.plannedRisk).plus(usage.unplannedRisk).toFixed(),
    dailyRiskCap: plan.dailyRiskCap,
    dailyLossCap: plan.dailyLossCap,
  };
}

function instrumentOptions(workspace: AccountWorkspace, symbol: string | null): InstrumentOption[] {
  return workspace.instruments
    .filter(instrument => symbol === null || instrument.symbol === symbol)
    .map(instrument => ({ id: instrument.id, label: `${instrument.symbol} · tick ${instrument.tickSize} · ${instrument.quantityUnit.split(" (")[0]}` }));
}

export async function loadTradeExtras(detail: TradeDetail): Promise<TradeExtras> {
  const { lifecycle } = detail.state;
  const planned = detail.origin === "PLANNED";
  const draft = lifecycle === "DRAFT" && planned;
  const liveFirstWithoutContract = !planned && lifecycle === "LIVE" && detail.technical.instrumentVersionId === null;
  try {
    if (draft) {
      const workspace = await getAccountWorkspace(detail.account.id);
      if (!workspace) return EMPTY_EXTRAS;
      const strategy = workspace.strategy && workspace.riskPlan ? cardOf(workspace.strategy.rules, workspace.riskPlan, detail.account.currency, DRAFT_CONTEXT) : null;
      return { ...EMPTY_EXTRAS, strategy, lockUsage: lockUsageOf(workspace) };
    }
    if (!planned) {
      const [records, workspace] = await Promise.all([positionRecords(detail), liveFirstWithoutContract ? getAccountWorkspace(detail.account.id) : null]);
      return { ...EMPTY_EXTRAS, positionRecords: records, instruments: workspace ? instrumentOptions(workspace, detail.symbol) : [] };
    }
    if (detail.plan) return { ...EMPTY_EXTRAS, strategy: await lockedStrategy(detail) };
    return { ...EMPTY_EXTRAS, lastProposal: await latestProposal(detail) };
  } catch (error) {
    unstable_rethrow(error);
    operationalFailure("data_read_failed");
    return EMPTY_EXTRAS;
  }
}
