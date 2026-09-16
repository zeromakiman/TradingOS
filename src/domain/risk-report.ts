import { z } from "zod";
import Decimal from "decimal.js";
import type {RiskContext} from "./risk";
import {strategyClock} from "./session";
const decimal=z.string().regex(/^\d+(\.\d+)?$/);
export const RISK_RULES=['INVALID_INPUT','INSTRUMENT_MISMATCH','CONTRACT_UNCONFIRMED','MISSING_STOP','PRICE_GEOMETRY','OFF_TICK','RISK_LIMIT','SIZING_INVARIANT','MINIMUM_QUANTITY','MIN_RR','MAX_TRADES','DEAD_POOL','DUPLICATE','STALE_EQUITY','STRATEGY_CONTRADICTION','NEWS_RESTRICTED','DAILY_RISK_LIMIT','DAILY_LOSS_LIMIT'] as const;
export const legacyRiskSchema=z.object({
  engineVersion:z.literal("1.0"),evaluatedAt:z.string(),tradingDay:z.string(),session:z.enum(["ASIA","JUDAS","ACTIVE_KILL_ZONE","DEAD_POOL"]),
  strategyVersionId:z.uuid(),riskPlanVersionId:z.uuid(),status:z.enum(["RISK_APPROVED","TRADE_BLOCKED"]),
  issues:z.array(z.object({code:z.string(),severity:z.enum(["BLOCK","WARN"]),message:z.string()})),
  calculations:z.object({budget:decimal,permittedRisk:decimal,stopDistance:decimal,stopTicks:decimal,stopPips:decimal.nullable(),plannedRR:decimal,quantity:decimal,nominalRisk:decimal,plannedReward:decimal}).nullable()
});
export const riskReportSchema=legacyRiskSchema.extend({
  reportVersion:z.literal("1.1"),decision:z.enum(["APPROVED","BLOCKED"]),requestedRiskPercent:decimal.nullable(),targetDistance:decimal.nullable(),sessionEligible:z.boolean(),
  snapshot:z.object({accountObservationId:z.uuid(),observationDay:z.string(),equity:decimal,currency:z.string(),instrumentVersionId:z.uuid(),slotsUsed:z.number().int().nonnegative(),executedTrades:z.null(),maximumDailyTrades:z.number().int().positive(),riskConsumed:decimal,grossLoss:decimal.nullable()}),
  ruleResults:z.array(z.object({rule:z.enum(RISK_RULES),outcome:z.enum(["PASS","BLOCK","WARN","NOT_EVALUATED"]),message:z.string()}))
}).strict().superRefine((report,ctx)=>{
  const blocked=report.issues.some(issue=>issue.severity==='BLOCK');
  if((report.decision==='BLOCKED')!==blocked || (report.status==='TRADE_BLOCKED')!==blocked || (!blocked && !report.calculations)) ctx.addIssue({code:'custom',message:'Risk decision is inconsistent with its findings or calculations.'});
  if(report.sessionEligible !== (report.session!=='DEAD_POOL')) ctx.addIssue({code:'custom',message:'Session eligibility is inconsistent.'});
  if(report.ruleResults.length!==RISK_RULES.length || new Set(report.ruleResults.map(r=>r.rule)).size!==RISK_RULES.length) ctx.addIssue({code:'custom',message:'Every hard rule must appear exactly once.'});
});
export type RiskReport=z.infer<typeof riskReportSchema>;
export function isRiskReportCurrent(report:RiskReport,context:RiskContext,observationId:string|undefined) {
  const clock=strategyClock(context.now);
  return report.tradingDay===clock.day && report.session===clock.session && report.snapshot.accountObservationId===observationId && report.riskPlanVersionId===context.plan.id && report.strategyVersionId===context.strategyVersionId && report.snapshot.instrumentVersionId===context.instrument.id && report.snapshot.slotsUsed===context.slotsUsed && new Decimal(report.snapshot.riskConsumed).eq(context.riskConsumed);
}
export const storedRiskSchema=z.union([riskReportSchema,legacyRiskSchema.strict()]);
export const evaluationEnvelopeSchema=z.object({planId:z.uuid().nullable(),evaluationId:z.uuid(),result:storedRiskSchema,replayed:z.boolean()}).strict();
