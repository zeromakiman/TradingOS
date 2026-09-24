import type { PlanRow } from "@/lib/data";
import type { JournalTrade } from "@/domain/analytics";
export interface ReviewEvent {id:string;event_type:string;payload:Record<string,unknown>;occurred_at:string;recorded_at:string}
export interface ReviewEvidence {id:string;role:string;sha256:string;mime_type:string;byte_size:number}
const pick=(value:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
/** Explicit allowlist. No account history, balance, equity, other plans, credentials or storage paths. */
export function tradeReviewContext(plan:PlanRow,trade:JournalTrade,strategy:{id:string;version:string;rules:Record<string,unknown>;written_rules:string},risk:Record<string,unknown>,events:ReviewEvent[],evidence:ReviewEvidence[]) {
 if(plan.id!==trade.id||plan.account_id!==trade.account_id)throw new Error("Trade context ownership mismatch");
 const r=plan.risk_result;
 return {version:"REVIEW_TRADE_FACTS_V1",tradeId:plan.id,capturedAt:new Date().toISOString(),
  originalPlan:{lockedAt:plan.locked_at,tradingDay:plan.trading_day,instrument:plan.instrument.symbol,proposal:pick(plan.proposal,["direction","model","entry","stop","target","riskPercent","news","narrative","contractConfirmed"]),initialNominalRisk:plan.nominal_risk},
  strategy:{id:strategy.id,version:strategy.version,rules:strategy.rules,writtenRules:strategy.written_rules},
  riskVersion:pick(risk,["id","version","effective_day","max_risk_percent","max_daily_trades","min_rr","rr_policy","news_policy","daily_risk_cap","daily_loss_cap"]),
  deterministic:{engineVersion:r.engineVersion,evaluatedAt:r.evaluatedAt,status:r.status,session:r.session,tradingDay:r.tradingDay,strategyVersionId:r.strategyVersionId,riskPlanVersionId:r.riskPlanVersionId,issues:r.issues,calculations:r.calculations,...("ruleResults" in r?{ruleResults:r.ruleResults}:{})},
  execution:pick(trade,["status","entry_price","quantity","entered_at","exit_price","exited_at","fees","net_pnl","realized_r","outcome","planned_entry","initial_stop","planned_quantity","initial_risk","risk_percent","entry_model","direction"]),
  tags:pick(trade,["setup_grade","liquidity_context","mss_timeframe","tag_source"]),
  events:events.map(e=>({...e,payload:pick(e.payload,["note","reason","entry","entry_price","quantity","exit","exit_price","fees","stop","target","price","status","realized_r","outcome","setup_grade","liquidity_context","mss_timeframe","source"])})),
  selectedEvidence:evidence.map(e=>({id:e.id,role:e.role,sha256:e.sha256,mimeType:e.mime_type,bytes:e.byte_size})),
  sourceRefs:["originalPlan","strategy","riskVersion","deterministic","execution","tags",...events.map(e=>`event:${e.id}`),...evidence.map(e=>`evidence:${e.id}`)]};
}
