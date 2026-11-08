import "server-only";
import { z } from "zod";
import {storedRiskSchema} from "@/domain/risk-report";

// PostgREST projections cast numeric columns before JSON serialization, preserving exact values.
const numeric = z.string();
export const PLAN_SELECT = "id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,proposal,risk_result,nominal_risk::text,locked_at,trading_day,setup_status,instrument:instrument_versions(symbol),strategy:strategy_versions(version),risk:risk_plan_versions(version)";
export const riskRow = z.object({ id: z.string().uuid(), version: z.string(), effective_day: z.string(), max_risk_percent: numeric, max_daily_trades: z.number(), min_rr: numeric, rr_policy: z.enum(["BLOCK", "WARN"]), news_policy: z.enum(["BLOCK", "WARN"]), daily_risk_cap: numeric.nullable(), daily_loss_cap: numeric.nullable() });
export const planRow = z.object({ id: z.string().uuid(), account_id: z.string().uuid(), strategy_version_id: z.string().uuid(), risk_plan_version_id: z.string().uuid(), instrument_version_id: z.string().uuid(), proposal: z.record(z.string(), z.unknown()), risk_result: storedRiskSchema, nominal_risk: numeric, locked_at: z.string(), trading_day: z.string(), setup_status: z.string(), instrument:z.object({symbol:z.string()}),strategy:z.object({version:z.string()}),risk:z.object({version:z.string()}) });
export type PlanRow = z.infer<typeof planRow>;
