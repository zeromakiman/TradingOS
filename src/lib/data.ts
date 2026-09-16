import "server-only";
import { z } from "zod";
import Decimal from "decimal.js";
import { requireUser } from "./supabase/server";
import { strategyClock } from "@/domain/session";
import type { Instrument, RiskPlan, RiskContext } from "@/domain/risk";
import {storedRiskSchema} from "@/domain/risk-report";

// PostgREST projections cast numeric columns before JSON serialization, preserving exact values.
const numeric = z.string();
export const PLAN_SELECT = "id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,proposal,risk_result,nominal_risk::text,locked_at,trading_day,setup_status,instrument:instrument_versions(symbol),strategy:strategy_versions(version),risk:risk_plan_versions(version)";
export const accountRow = z.object({ id: z.string().uuid(), name: z.string(), currency: z.string() });
export const observationRow = z.object({ id: z.string().uuid(), equity: numeric, balance: numeric, gross_loss_today: numeric.nullable(), trading_day: z.string(), recorded_at: z.string() });
export const riskRow = z.object({ id: z.string().uuid(), version: z.string(), effective_day: z.string(), max_risk_percent: numeric, max_daily_trades: z.number(), min_rr: numeric, rr_policy: z.enum(["BLOCK", "WARN"]), news_policy: z.enum(["BLOCK", "WARN"]), daily_risk_cap: numeric.nullable(), daily_loss_cap: numeric.nullable() });
export const instrumentRow = z.object({ id: z.string().uuid(), symbol: z.string(), currency: z.string(), quantity_unit: z.string(), tick_size: numeric, pip_size: numeric.nullable(), tick_value: numeric, quantity_step: numeric, minimum_quantity: numeric });
export const planRow = z.object({ id: z.string().uuid(), account_id: z.string().uuid(), strategy_version_id: z.string().uuid(), risk_plan_version_id: z.string().uuid(), instrument_version_id: z.string().uuid(), proposal: z.record(z.string(), z.unknown()), risk_result: storedRiskSchema, nominal_risk: numeric, locked_at: z.string(), trading_day: z.string(), setup_status: z.string(), instrument:z.object({symbol:z.string()}),strategy:z.object({version:z.string()}),risk:z.object({version:z.string()}) });
export type PlanRow = z.infer<typeof planRow>;
export async function loadWorkspace(accountId?: string) {
  const { db, user } = await requireUser();
  const { data, error } = await db.from("accounts").select("id,name,currency").order("created_at");
  if (error) throw new Error("Unable to load accounts. Check the database connection and migrations.");
  const accounts = z.array(accountRow).parse(data);
  const account = accounts.find(a => a.id === accountId) ?? accounts[0];
  if (!account) return { user, accounts, current: null };
  const now = new Date().toISOString(), day = strategyClock(now).day;
  const results = await Promise.all([
    db.from("account_observations").select("id,equity::text,balance::text,gross_loss_today::text,trading_day,recorded_at").eq("account_id", account.id).order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(1).single(),
    db.from("risk_plan_versions").select("id,version,effective_day,max_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text").eq("account_id", account.id).lte("effective_day", day).order("effective_day", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).single(),
    db.from("instrument_versions").select("id,symbol,currency,quantity_unit,tick_size::text,pip_size::text,tick_value::text,quantity_step::text,minimum_quantity::text").eq("account_id", account.id).order("symbol"),
    db.from("strategy_versions").select("id,version,rules").eq("account_id", account.id).eq("version", "ICT V1.0").single(),
    db.from("daily_contexts").select("narrative").eq("account_id", account.id).eq("trading_day", day).order("recorded_at", { ascending: false }).order("id",{ascending:false}).limit(1),
    db.from("trade_plans").select("id,nominal_risk::text").eq("account_id",account.id).eq("trading_day",day).order("locked_at",{ascending:false})
  ]);
  if (results.some(r => r.error)) throw new Error("Unable to load account records. Check that all migrations have been applied.");
  const observation = observationRow.parse(results[0].data);
  const row = riskRow.parse(results[1].data);
  const riskPlan: RiskPlan = { id: row.id, version: row.version, maxRiskPercent: row.max_risk_percent, maxDailyTrades: row.max_daily_trades, minRR: row.min_rr, rrPolicy: row.rr_policy, newsPolicy: row.news_policy, dailyRiskCap: row.daily_risk_cap, dailyLossCap: row.daily_loss_cap };
  const instruments: Instrument[] = z.array(instrumentRow).parse(results[2].data).map(i => ({ id: i.id, symbol: i.symbol, currency: i.currency, quantityUnit: i.quantity_unit, tickSize: i.tick_size, pipSize: i.pip_size, tickValue: i.tick_value, quantityStep: i.quantity_step, minimumQuantity: i.minimum_quantity }));
  const strategy = z.object({ id: z.string().uuid(), version: z.string(), rules: z.record(z.string(), z.unknown()) }).parse(results[3].data);
  const todayPlans = z.array(z.object({id:z.uuid(),nominal_risk:z.string()})).parse(results[5].data);
  const riskConsumed = todayPlans.reduce((sum, p) => sum.plus(p.nominal_risk), new Decimal(0)).toFixed();
  const context: RiskContext = { now, observationDay: observation.trading_day, strategyVersionId: strategy.id, equity: observation.equity, currency: account.currency, plan: riskPlan, instrument: instruments[0], slotsUsed: todayPlans.length, riskConsumed, grossLoss: observation.trading_day === day ? observation.gross_loss_today : null, duplicate: false };
  const narratives = z.array(z.object({ narrative: z.string() })).parse(results[4].data);
  return { user, accounts, current: { account, observation, riskPlan, strategy, instruments, todayPlans, context, narrative: narratives[0]?.narrative ?? "" } };
}
