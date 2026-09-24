import {metrics,type JournalTrade} from "@/domain/analytics";
import {tradeReviewContext,type ReviewEvent} from "./trade-review-context";
import {weeklyPeriod} from "./weekly-period";
export const WEEKLY_LIMITS=Object.freeze({trades:40,events:200,bytes:96000});
type TradeContext=Parameters<typeof tradeReviewContext>;
export interface WeeklyTradeSource {plan:TradeContext[0];trade:JournalTrade;strategy:TradeContext[2];risk:TradeContext[3];events:ReviewEvent[]}
export function weeklyReviewContext(accountId:string,day:string,sources:WeeklyTradeSource[],capturedAt=new Date().toISOString()){
 const period=weeklyPeriod(day);
 if(sources.length>WEEKLY_LIMITS.trades||sources.reduce((n,s)=>n+s.events.length,0)>WEEKLY_LIMITS.events)throw new Error("Week exceeds bounded review limits; no trades were omitted or sent.");
 const ids=new Set<string>();
 const trades=sources.map(s=>{
  if(s.trade.account_id!==accountId||s.plan.account_id!==accountId||s.trade.status!=="CLOSED"||s.trade.realized_r===null||!s.trade.exited_at||Date.parse(s.trade.exited_at)<Date.parse(period.start)||Date.parse(s.trade.exited_at)>=Date.parse(period.endExclusive)||ids.has(s.trade.id))throw new Error("Weekly trade scope mismatch");
  if(s.strategy.id!==s.plan.strategy_version_id||s.risk.id!==s.plan.risk_plan_version_id)throw new Error("Weekly version mismatch");
  ids.add(s.trade.id);
  if(s.events.some(e=>Date.parse(e.occurred_at)<Date.parse(period.start)||Date.parse(e.occurred_at)>=Date.parse(period.endExclusive)||Date.parse(e.recorded_at)<Date.parse(period.start)||Date.parse(e.recorded_at)>=Date.parse(period.endExclusive)))throw new Error("Weekly event scope mismatch");
  const context=tradeReviewContext(s.plan,s.trade,s.strategy,s.risk,s.events,[]);
  // The analytics view's latest tags could have been written after this week. Only period events are sent.
  return {tradeId:context.tradeId,originalPlan:context.originalPlan,strategy:context.strategy,riskVersion:context.riskVersion,deterministic:context.deterministic,execution:context.execution,events:context.events};
 });
 const edge=metrics(sources.map(s=>s.trade));
 return {version:"WEEKLY_REVIEW_FACTS_V1",capturedAt,period,
  scope:"Only this account's completed trades by exit time. Original plan/execution may precede the week. Notes/events/tags must have occurred AND been recorded within the week. No screenshots, prior AI output, open trades, unrelated periods or account balances are supplied.",
  sample:{count:edge.completed,label:edge.sample,caveat:edge.completed<30?"Small sample: observations are tentative and cannot establish a reliable recurring pattern or improvement versus other weeks.":"One selected week cannot establish improvement versus unprovided weeks or prove a behavioral cause."},
  edge,trades,sourceRefs:["period","sample","edge",...trades.map(t=>"trade:"+t.tradeId)]};
}
export type WeeklyReviewFacts=ReturnType<typeof weeklyReviewContext>;
