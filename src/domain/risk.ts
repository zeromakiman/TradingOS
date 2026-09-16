import Decimal from "decimal.js";
import { z } from "zod";
import { strategyClock } from "./session";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
export const decimalString = z.string().refine(v => /^\d{1,12}(\.\d{1,8})?$/.test(v) && new D(v).gt(0), "Use a positive decimal, up to 8 decimal places.");
export const moneyString = z.string().refine(v => /^\d{1,12}(\.\d{1,2})?$/.test(v) && new D(v).gt(0), "Use a positive monetary amount with up to two decimal places.");
export const proposalSchema = z.object({
  instrumentId: z.string().uuid(), direction: z.enum(["LONG", "SHORT"]), model: z.enum(["OB_FIRST_TOUCH", "OTE"]),
  entry: decimalString, stop: decimalString.nullable(), target: decimalString,
  riskPercent: decimalString, narrative: z.string().trim().min(1).max(5000),
  contractConfirmed: z.boolean(), news: z.enum(["UNKNOWN", "CLEAR", "RESTRICTED"]),
  contradiction: z.boolean()
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;
export interface RiskPlan {
  id: string; version: string; maxRiskPercent: string; maxDailyTrades: number;
  minRR: string; rrPolicy: "BLOCK" | "WARN"; newsPolicy: "BLOCK" | "WARN";
  dailyRiskCap: string | null; dailyLossCap: string | null;
}
export interface Instrument {
  id: string; symbol: string; currency: string; quantityUnit: string;
  tickSize: string; pipSize: string | null; tickValue: string; quantityStep: string; minimumQuantity: string;
}
export interface RiskContext {
  now: string; strategyVersionId: string; equity: string; currency: string; observationDay: string;
  plan: RiskPlan; instrument: Instrument; slotsUsed: number;
  riskConsumed: string; grossLoss: string | null; duplicate: boolean;
}
export interface RiskIssue { code: string; severity: "BLOCK" | "WARN"; message: string }
export interface RiskResult {
  engineVersion: "1.0"; evaluatedAt: string; tradingDay: string; session: string;
  strategyVersionId: string; riskPlanVersionId: string; status: "RISK_APPROVED" | "TRADE_BLOCKED";
  issues: RiskIssue[];
  calculations: null | { budget: string; permittedRisk: string; stopDistance: string; stopTicks: string; stopPips: string | null; plannedRR: string; quantity: string; nominalRisk: string; plannedReward: string };
}

export function evaluateRisk(raw: unknown, ctx: RiskContext): RiskResult {
  const clock = strategyClock(ctx.now);
  const issues: RiskIssue[] = [];
  const add = (code: string, severity: RiskIssue["severity"], message: string) => issues.push({ code, severity, message });
  const result: RiskResult = { engineVersion: "1.0", evaluatedAt: ctx.now, tradingDay: clock.day, session: clock.session, strategyVersionId: ctx.strategyVersionId, riskPlanVersionId: ctx.plan.id, status: "TRADE_BLOCKED", issues, calculations: null };
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) { add("INVALID_INPUT", "BLOCK", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")); return result; }
  const p = parsed.data;
  const spec = ctx.instrument;
  const positive = [ctx.equity, spec.tickSize, spec.tickValue, spec.quantityStep, spec.minimumQuantity, ctx.plan.maxRiskPercent, ctx.plan.minRR];
  const optionalPositive = [spec.pipSize, ctx.plan.dailyRiskCap, ctx.plan.dailyLossCap];
  const nonnegative = [ctx.riskConsumed, ctx.grossLoss].filter((v): v is string => v !== null);
  if (positive.some(v => !decimalString.safeParse(v).success) || optionalPositive.some(v => v !== null && !decimalString.safeParse(v).success) || nonnegative.some(v => !/^\d{1,24}(\.\d{1,24})?$/.test(v)) || !Number.isInteger(ctx.plan.maxDailyTrades) || ctx.plan.maxDailyTrades < 1 || ctx.plan.maxDailyTrades > 100 || !Number.isInteger(ctx.slotsUsed) || ctx.slotsUsed < 0) {
    add("INVALID_CONTEXT", "BLOCK", "Account, instrument or risk configuration is invalid."); return result;
  }
  if (new D(ctx.plan.maxRiskPercent).gt(100) || new D(ctx.plan.minRR).gt(100)) { add("INVALID_CONTEXT", "BLOCK", "Risk configuration exceeds supported bounds."); return result; }
  if (p.instrumentId !== spec.id || spec.currency !== ctx.currency) add("INSTRUMENT_MISMATCH", "BLOCK", "An instrument valued in the account currency is required.");
  if (!p.contractConfirmed) add("CONTRACT_UNCONFIRMED", "BLOCK", "Confirm that the instrument contract matches your demo broker.");
  if (p.stop === null) { add("MISSING_STOP", "BLOCK", "A stop loss is required."); return result; }
  const entry = new D(p.entry), stop = new D(p.stop), target = new D(p.target);
  const correct = p.direction === "LONG" ? stop.lt(entry) && target.gt(entry) : stop.gt(entry) && target.lt(entry);
  if (!correct) { add("PRICE_GEOMETRY", "BLOCK", "Stop and target must be on the correct sides of entry."); return result; }
  const tick = new D(spec.tickSize);
  if ([entry, stop, target].some(v => !v.mod(tick).isZero())) add("OFF_TICK", "BLOCK", "Entry, stop and target must align to the instrument tick size.");
  const distance = entry.minus(stop).abs();
  const stopTicks = distance.div(tick);
  const budget = new D(ctx.equity).mul(p.riskPercent).div(100).toDecimalPlaces(2, D.ROUND_DOWN);
  const permittedRisk = new D(ctx.equity).mul(ctx.plan.maxRiskPercent).div(100).toDecimalPlaces(2, D.ROUND_DOWN);
  const riskPerQuantity = stopTicks.mul(spec.tickValue);
  const quantity = budget.div(riskPerQuantity).div(spec.quantityStep).floor().mul(spec.quantityStep);
  const nominalRisk = quantity.mul(riskPerQuantity);
  if (nominalRisk.gt(budget)) { add("SIZING_INVARIANT", "BLOCK", "Position sizing exceeded the risk budget."); return result; }
  const rewardDistance = target.minus(entry).abs();
  const rr = rewardDistance.div(distance);
  result.calculations = { budget: budget.toFixed(2), permittedRisk: permittedRisk.toFixed(2), stopDistance: distance.toFixed(), stopTicks: stopTicks.toFixed(), stopPips: spec.pipSize ? distance.div(spec.pipSize).toFixed(4) : null, plannedRR: rr.toFixed(8), quantity: quantity.toFixed(), nominalRisk: nominalRisk.toFixed(), plannedReward: rewardDistance.div(tick).mul(spec.tickValue).mul(quantity).toFixed() };
  if (new D(p.riskPercent).gt(ctx.plan.maxRiskPercent)) add("RISK_LIMIT", "BLOCK", "Requested risk exceeds the risk-plan maximum.");
  if (quantity.lt(spec.minimumQuantity)) add("MINIMUM_QUANTITY", "BLOCK", "Risk budget is too small for the minimum position size.");
  // Cross multiplication avoids changing the verdict due to display rounding.
  if (rewardDistance.lt(distance.mul(ctx.plan.minRR))) add("MIN_RR", ctx.plan.rrPolicy, `Planned RR is below ${ctx.plan.minRR}.`);
  if (ctx.slotsUsed >= ctx.plan.maxDailyTrades) add("MAX_TRADES", "BLOCK", "Maximum daily trades and reserved slots reached.");
  if (clock.session === "DEAD_POOL") add("DEAD_POOL", "BLOCK", "Dead Pool: no new discretionary plans from 12:00 to 18:00 UTC−5.");
  else if (clock.session !== "ACTIVE_KILL_ZONE") add("OUTSIDE_ACTIVE", "WARN", "Outside the active 02:00–12:00 kill zone.");
  if (ctx.duplicate) add("DUPLICATE", "BLOCK", "An identical plan already reserves a slot today.");
  if (ctx.observationDay !== clock.day) add("STALE_EQUITY", "BLOCK", "Record or reconfirm current account values for this trading day before locking.");
  if (p.contradiction) add("STRATEGY_CONTRADICTION", "BLOCK", "A strategy contradiction has been reported.");
  if (p.news === "RESTRICTED") add("NEWS_RESTRICTED", ctx.plan.newsPolicy, "A restricted news environment has been reported.");
  if (p.news === "UNKNOWN") add("NEWS_UNKNOWN", "WARN", "Economic news has not been verified.");
  if (ctx.plan.dailyRiskCap === null) add("DAILY_RISK_UNCONFIGURED", "WARN", "No daily monetary risk cap is configured.");
  else if (new D(ctx.riskConsumed).plus(nominalRisk).gt(ctx.plan.dailyRiskCap)) add("DAILY_RISK_LIMIT", "BLOCK", "The daily monetary risk cap would be exceeded.");
  if (ctx.plan.dailyLossCap === null) add("DAILY_LOSS_UNCONFIGURED", "WARN", "No daily loss cap is configured.");
  else if (ctx.grossLoss === null) add("DAILY_LOSS_UNKNOWN", "BLOCK", "A configured daily loss cap requires a reported loss total.");
  else if (new D(ctx.grossLoss).plus(ctx.riskConsumed).plus(nominalRisk).gt(ctx.plan.dailyLossCap)) add("DAILY_LOSS_LIMIT", "BLOCK", "Recorded gross losses plus reserved exposure exceed the daily loss cap.");
  add("COSTS_UNKNOWN", "WARN", "Sizing reflects nominal stop risk; fees, gaps and slippage are not included.");
  result.status = issues.some(i => i.severity === "BLOCK") ? "TRADE_BLOCKED" : "RISK_APPROVED";
  return result;
}
