import { z } from "zod";
import Decimal from "decimal.js";
import type {RiskContext} from "./risk";
import {strategyClock} from "./session";
import {isInstant} from "./time-display";
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

/**
 * Whether a stored APPROVED check still describes the present (spec §2.2, §6.4): same strategy day and
 * session at `now`, same observation, risk plan, strategy and instrument versions, and the same daily
 * usage. `now` is the server time the page was rendered with, never the browser clock (V1 finding C8);
 * the lock RPC re-evaluates on the server regardless. `context.now` is not read: only `now` decides.
 * - The context's usage must be the usage of the strategy day of `now` (a usage computed for another
 *   day, e.g. across midnight UTC−5, says nothing about today), else the report is not current.
 * - Report 1.2: every usage component the report was computed with must equal the context's usage.
 * - Reports of engine 1.0 (report 1.1 and legacy) are never current: they cannot certify what engine 1.1
 *   decides at the lock. Their daily loss rule added a typed loss total to every reservation, without the
 *   realized, external and open-exposure components engine 1.1 reads, and their thesis check trimmed
 *   spaces only; equal slots and reserved risk can still lock as BLOCKED. Their recheck is free.
 */
export function isRiskReportCurrent(report:StoredRiskReport,context:RiskContext,observationId:string|undefined,now:string|Date):boolean {
  if(!("reportVersion" in report) || report.reportVersion!=="1.2" || observationId===undefined) return false;
  const clock=strategyClock(now);
  const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  const usage=context.usage;
  if(usage.day!==clock.day) return false;
  if(report.tradingDay!==clock.day || report.session!==clock.session || !same(report.snapshot.accountObservationId,observationId)
    || !same(report.riskPlanVersionId,context.plan.id) || !same(report.strategyVersionId,context.strategyVersionId)
    || !same(report.snapshot.instrumentVersionId,context.instrument.id)) return false;
  const s=report.snapshot;
  const legacySame=s.legacyReportedLoss===null||usage.legacyReportedLoss===null
    ? s.legacyReportedLoss===usage.legacyReportedLoss
    : new exact(s.legacyReportedLoss).eq(usage.legacyReportedLoss);
  return legacySame
    && s.plannedSlots===usage.plannedSlots && s.unplannedTrades===usage.unplannedTrades
    && s.unplannedRiskUnknown===usage.unplannedRiskUnknown && s.openRiskUnknown===usage.openRiskUnknown && s.riskUnknownTrades===usage.riskUnknownTrades
    && new exact(s.plannedRisk).eq(usage.plannedRisk) && new exact(s.unplannedRisk).eq(usage.unplannedRisk)
    && new exact(s.realizedLoss).eq(usage.realizedLoss) && new exact(s.externalLoss).eq(usage.externalLoss)
    && new exact(s.openExposure).eq(usage.openExposure) && new exact(s.grossLoss).eq(usage.lossTotal);
}

// ---------------------------------------------------------------------------------------------
// Report 1.2 (engine 1.1, spec §6.4): self-describing limits/instrument, per-issue params and the
// daily usage composition. Every number is canonical text (SQL trim_scale / TS toFixed without
// trailing zeros, never exponent notation). Stored 1.1 and legacy reports remain valid below.
// ---------------------------------------------------------------------------------------------
const exact=Decimal.clone({precision:100});
const canonical=z.string().regex(/^(0|[1-9]\d*)(\.\d*[1-9])?$/,"Expected a canonical decimal string.");
const tally=z.number().int().nonnegative();
const policy=z.enum(["BLOCK","WARN"]);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const issueParams=z.record(z.string(),z.union([z.string().max(500),z.number(),z.null()]));
export const riskReportSchemaV12=z.object({
  engineVersion:z.literal("1.1"),reportVersion:z.literal("1.2"),
  evaluatedAt:z.string().refine(isInstant,"Expected a timestamp with an explicit timezone."),tradingDay:day,
  session:z.enum(["ASIA","JUDAS","ACTIVE_KILL_ZONE","DEAD_POOL"]),strategyVersionId:z.uuid(),riskPlanVersionId:z.uuid(),
  decision:z.enum(["APPROVED","BLOCKED"]),status:z.enum(["RISK_APPROVED","TRADE_BLOCKED"]),
  issues:z.array(z.object({code:z.string().min(1).max(64),severity:policy,message:z.string(),params:issueParams}).strict()),
  ruleResults:z.array(z.object({rule:z.enum(RISK_RULES),outcome:z.enum(["PASS","BLOCK","WARN","NOT_EVALUATED"]),message:z.string()}).strict()),
  requestedRiskPercent:canonical.nullable(),targetDistance:canonical.nullable(),sessionEligible:z.boolean(),
  calculations:z.object({budget:canonical,permittedRisk:canonical,stopDistance:canonical,stopTicks:canonical,stopPips:canonical.nullable(),plannedRR:canonical,quantity:canonical,nominalRisk:canonical,plannedReward:canonical}).strict().nullable(),
  limits:z.object({maxRiskPercent:canonical,defaultRiskPercent:canonical.nullable(),minRR:canonical,rrPolicy:policy,newsPolicy:policy,maxDailyTrades:z.number().int().min(1).max(100),dailyRiskCap:canonical.nullable(),dailyLossCap:canonical.nullable(),riskPlanVersion:z.string().min(1)}).strict(),
  instrument:z.object({symbol:z.string().min(1),currency:z.string().regex(/^[A-Z]{3}$/),tickSize:canonical,pipSize:canonical.nullable(),tickValue:canonical,quantityStep:canonical,minimumQuantity:canonical,quantityUnit:z.string()}).strict(),
  snapshot:z.object({
    accountObservationId:z.uuid(),observationDay:day,equity:canonical,currency:z.string(),instrumentVersionId:z.uuid(),
    slotsUsed:tally,executedTrades:tally,maximumDailyTrades:z.number().int().positive(),riskConsumed:canonical,grossLoss:canonical,
    plannedSlots:tally,unplannedTrades:tally,plannedRisk:canonical,unplannedRisk:canonical,unplannedRiskUnknown:tally,
    realizedLoss:canonical,externalLoss:canonical,legacyReportedLoss:canonical.nullable(),openExposure:canonical,openRiskUnknown:tally,
    // Distinct live-first/imported trades without a risk basis entered today or still open (§6.2): the two counters above overlap.
    riskUnknownTrades:tally,
  }).strict(),
}).strict().superRefine((report,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  const blocked=report.issues.some(issue=>issue.severity==='BLOCK');
  if((report.decision==='BLOCKED')!==blocked || (report.status==='TRADE_BLOCKED')!==blocked || (!blocked && !report.calculations)) fail('Risk decision is inconsistent with its findings or calculations.');
  if(report.sessionEligible !== (report.session!=='DEAD_POOL')) fail('Session eligibility is inconsistent.');
  if(report.ruleResults.length!==RISK_RULES.length || new Set(report.ruleResults.map(r=>r.rule)).size!==RISK_RULES.length) fail('Every hard rule must appear exactly once.');
  const outcomes=new Map<string,string>(report.ruleResults.map(r=>[r.rule,r.outcome]));
  if(report.issues.some(issue=>outcomes.has(issue.code) && outcomes.get(issue.code)!==issue.severity) || report.ruleResults.some(r=>(r.outcome==='BLOCK'||r.outcome==='WARN') && !report.issues.some(issue=>issue.code===r.rule && issue.severity===r.outcome))) fail('Rule results are inconsistent with the reported issues.');
  const s=report.snapshot;
  const lossTotal=exact.max(s.legacyReportedLoss ?? 0,new exact(s.realizedLoss).plus(s.externalLoss));
  if(s.slotsUsed!==s.plannedSlots+s.unplannedTrades || s.executedTrades!==s.unplannedTrades || !new exact(s.riskConsumed).eq(new exact(s.plannedRisk).plus(s.unplannedRisk)) || !lossTotal.eq(s.grossLoss) || s.maximumDailyTrades!==report.limits.maxDailyTrades) fail('Daily usage snapshot is inconsistent.');
  if(s.riskUnknownTrades<Math.max(s.unplannedRiskUnknown,s.openRiskUnknown) || s.riskUnknownTrades>s.unplannedRiskUnknown+s.openRiskUnknown) fail('Trades without recorded risk must be counted once each.');
  if(report.limits.defaultRiskPercent!==null && new exact(report.limits.defaultRiskPercent).gt(report.limits.maxRiskPercent)) fail('Default risk exceeds the configured maximum.');
});
export type RiskReportV12=z.infer<typeof riskReportSchemaV12>;
const storedV11OrLegacySchema=z.union([riskReportSchema,legacyRiskSchema.strict()]);
export const storedRiskSchema=z.union([riskReportSchemaV12,riskReportSchema,legacyRiskSchema.strict()]);
export type StoredRiskReport=z.infer<typeof storedRiskSchema>;
// V1 lock/evaluate envelopes keep their original contract (1.1 | legacy); V2 RPC envelopes use storedRiskSchema.
export const evaluationEnvelopeSchema=z.object({planId:z.uuid().nullable(),evaluationId:z.uuid(),result:storedV11OrLegacySchema,replayed:z.boolean()}).strict();
