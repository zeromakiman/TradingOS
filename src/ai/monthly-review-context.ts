import {metrics,enrichTrades,groups,type JournalTrade} from "@/domain/analytics";
import {tradeReviewContext,type ReviewEvent} from "./trade-review-context";
import {monthlyPeriod} from "./monthly-period";
export const MONTHLY_LIMITS=Object.freeze({trades:120,events:500,bytes:128000,detailedTrades:30,detailedBytes:96000});
type TradeContext=Parameters<typeof tradeReviewContext>;
export interface MonthlyTradeSource {plan:TradeContext[0];trade:JournalTrade;strategy:TradeContext[2];risk:TradeContext[3];events:ReviewEvent[]}
export function monthlyReviewContext(accountId:string,month:string,sources:MonthlyTradeSource[],capturedAt=new Date().toISOString()){
 const period=monthlyPeriod(month),ids=new Set<string>();
 if(sources.length>MONTHLY_LIMITS.trades||sources.reduce((n,s)=>n+s.events.length,0)>MONTHLY_LIMITS.events)throw new Error("Month exceeds bounded review limits; nothing was sent.");
 const enriched=enrichTrades(sources.map(s=>s.trade)),strategies=new Map<string,ReturnType<typeof tradeReviewContext>["strategy"]>(),risks=new Map<string,ReturnType<typeof tradeReviewContext>["riskVersion"]>();
 const within=(time:string)=>Number.isFinite(Date.parse(time))&&Date.parse(time)>=Date.parse(period.start)&&Date.parse(time)<Date.parse(period.endExclusive);
 const detailed=sources.map((s,i)=>{
  if(s.plan.id!==s.trade.id||s.trade.account_id!==accountId||s.plan.account_id!==accountId||s.trade.status!=="CLOSED"||s.trade.realized_r===null||!s.trade.exited_at||!within(s.trade.exited_at)||ids.has(s.trade.id))throw new Error("Monthly trade scope mismatch");
  if(s.strategy.id!==s.plan.strategy_version_id||s.risk.id!==s.plan.risk_plan_version_id)throw new Error("Monthly version mismatch");
  if(s.events.some(e=>!within(e.occurred_at)||!within(e.recorded_at)))throw new Error("Monthly event scope mismatch");
  ids.add(s.trade.id);const c=tradeReviewContext(s.plan,s.trade,s.strategy,s.risk,s.events,[]);
  strategies.set(s.strategy.id,c.strategy);risks.set(s.plan.risk_plan_version_id,c.riskVersion);
  return {tradeId:c.tradeId,originalPlan:c.originalPlan,strategyVersionId:s.strategy.id,riskPlanVersionId:s.plan.risk_plan_version_id,deterministic:c.deterministic,execution:c.execution,session:enriched[i].session,weekday:enriched[i].weekday,events:c.events};
 });
 const edge=metrics(sources.map(s=>s.trade)),breakdowns={entryModels:groups(enriched,t=>t.entry_model,["OB_FIRST_TOUCH","OTE"]),sessions:groups(enriched,t=>t.session)};
 const sample={count:edge.completed,tradeIds:[...ids],label:edge.sample,caveat:edge.completed<30?"Small sample: observations are tentative and cannot establish reliable recurring patterns or improvement versus unprovided months.":"One selected month cannot establish improvement versus unprovided months or prove behavioral causes."};
 const base={version:"MONTHLY_REVIEW_FACTS_V1",capturedAt,period,sample,edge,breakdowns};
 const full={...base,mode:"DETAILED",scope:"All selected-month completed trades, original plans/versions and executions. Original plan or entry may precede the month. Notes/events/tags must have occurred AND been recorded within the month. No latest out-of-period tags, screenshots, prior AI outputs, balances or other months.",trades:detailed,strategyVersions:[...strategies.values()],riskVersions:[...risks.values()],sourceRefs:["period","sample","edge","models","sessions",...detailed.map(t=>"trade:"+t.tradeId)]};
 if(detailed.length<=MONTHLY_LIMITS.detailedTrades&&new TextEncoder().encode(JSON.stringify(full)).length<=MONTHLY_LIMITS.detailedBytes)return full;
 // Explicit deterministic aggregation of the entire sample, never a silent subset or AI-generated summary.
 return {...base,mode:"DETERMINISTIC SUMMARY",scope:"All selected trades contribute to unchanged domain EDGE/model/session metrics; exact IDs and original version identities are retained. Individual plans, executions, rules, narrative, notes and tags are omitted in this bounded mode. Rule/process/behavioral causes and improvement cannot be inferred from outcomes. No screenshots, prior AI outputs, balances or other months.",
  trades:detailed.map(t=>({tradeId:t.tradeId})),strategyVersions:[...strategies.values()].map(s=>({id:s.id,version:s.version})),riskVersions:[...risks.values()].map(r=>({id:r.id,version:r.version})),
  omitted:{individualTradeDetails:detailed.length,eventDetails:sources.reduce((n,s)=>n+s.events.length,0),strategyDefinitions:strategies.size,riskDefinitions:risks.size},sourceRefs:["period","sample","edge","models","sessions"]};
}
export type MonthlyReviewFacts=ReturnType<typeof monthlyReviewContext>;
