import {withOperationSources,verifiedPeriodicFactsV2} from "./citation-sources";
import {z} from "zod";
import {metrics,enrichTrades,type JournalTrade} from "@/domain/analytics";
import {tradeReviewContext,type ReviewEvent} from "./trade-review-context";
import {namedVersions,PERIODIC_RECORD_RULES,periodicTrade,snapshotVersions,type PeriodicTradeSource} from "./periodic-facts";
import {compactEdge,periodicRecordCount,PERIODIC_V2_LIMITS} from "./periodic-limits";
/** Bounds of the V1 facts (RECENT_TRADES_FACTS_V1, kept for stored history). New requests use PERIODIC_V2_LIMITS. */
export const RECENT_LIMITS=Object.freeze({events:300,bytes:128000});
export function recentSample(value:unknown=20):10|20|30{
 return Number(z.enum(["10","20","30"]).parse(typeof value==="number"?String(value):value)) as 10|20|30;
}
type TradeContext=Parameters<typeof tradeReviewContext>;
export interface RecentTradeSource {plan:TradeContext[0];trade:JournalTrade;strategy:TradeContext[2];risk:TradeContext[3];events:ReviewEvent[]}
/** RECENT_TRADES_FACTS_V1: the original facts of stored analyses (full report and written rules per version). */
export function recentTradesContext(accountId:string,requested:10|20|30,sources:RecentTradeSource[],capturedAt:string){
 recentSample(requested);
 if(sources.length>requested||sources.reduce((n,s)=>n+s.events.length,0)>RECENT_LIMITS.events)throw new Error("Sample exceeds bounded analysis limits; nothing was omitted.");
 const ids=new Set<string>(),strategies=new Map<string,ReturnType<typeof tradeReviewContext>["strategy"]>(),risks=new Map<string,ReturnType<typeof tradeReviewContext>["riskVersion"]>();
 const clocks=enrichTrades(sources.map(s=>s.trade));
 const trades=sources.map((s,i)=>{
  if(s.trade.account_id!==accountId||s.plan.account_id!==accountId||s.plan.id!==s.trade.id||s.trade.status!=="CLOSED"||s.trade.realized_r===null||!s.trade.exited_at||!Number.isFinite(Date.parse(s.trade.exited_at))||Date.parse(s.trade.exited_at)>Date.parse(capturedAt)||ids.has(s.trade.id))throw new Error("Recent trade scope mismatch");
  if(s.strategy.id!==s.plan.strategy_version_id||s.risk.id!==s.plan.risk_plan_version_id)throw new Error("Recent version mismatch");
  if(s.events.some(e=>!Number.isFinite(Date.parse(e.occurred_at))||!Number.isFinite(Date.parse(e.recorded_at))||Date.parse(e.occurred_at)>Date.parse(capturedAt)||Date.parse(e.recorded_at)>Date.parse(capturedAt)))throw new Error("Recent event scope mismatch");
  ids.add(s.trade.id);
  const c=tradeReviewContext(s.plan,s.trade,s.strategy,s.risk,s.events,[]);
  strategies.set(s.strategy.id,c.strategy);risks.set(s.plan.risk_plan_version_id,c.riskVersion);
  return {tradeId:c.tradeId,originalPlan:c.originalPlan,strategyVersionId:s.strategy.id,riskPlanVersionId:s.plan.risk_plan_version_id,deterministic:c.deterministic,execution:c.execution,entrySession:clocks[i].session,entryWeekday:clocks[i].weekday,tags:c.tags,events:c.events};
 });
 const edge=metrics(sources.map(s=>s.trade));
 return withOperationSources("RECENT_TRADES_ANALYSIS",{version:"RECENT_TRADES_FACTS_V1",capturedAt,
  sample:{requested,actual:trades.length,tradeIds:trades.map(t=>t.tradeId),label:edge.sample,fewerThanRequested:trades.length<requested,caveat:(trades.length<requested?"Fewer completed trades are available than requested. ":"")+(trades.length<30?"Small sample: patterns are tentative, not established behavioral conclusions.":"Thirty trades are a limited sample; patterns remain tentative and do not prove behavioral causes."),ordering:"Persisted exit timestamp descending (PostgreSQL microseconds), then trade UUID ascending for exact ties."},
  scope:"Only the selected most recent completed trades, their original versions, current manual tags and relevant recorded events. No open trades, other account history, screenshots, prior AI output or account balances. Sample is refreshed on explicit submission; exact included IDs are preserved.",
  strategyVersions:[...strategies.values()],riskVersions:[...risks.values()],edge,trades,
  sourceRefs:["sample","edge",...trades.map(t=>"trade:"+t.tradeId),...[...strategies.keys()].map(id=>"strategy:"+id),...[...risks.keys()].map(id=>"risk:"+id)]});
}
export type RecentTradesFacts=ReturnType<typeof recentTradesContext>;

/**
 * RECENT_TRADES_FACTS_V2 (new requests): the latest N completed planned trades as compact deterministic facts
 * (src/ai/periodic-facts.ts) with their V2 journal entries and tags recorded up to the capture time, strategy and risk
 * versions once each, and the sample's EDGE metrics. Live-first and imported trades have no locked plan and are not
 * part of the sample (spec §11.5). Exceeding a bound refuses the whole sample; nothing is omitted.
 */
export function recentTradesContextV2(accountId:string,requested:10|20|30,sources:PeriodicTradeSource[],capturedAt:string,currency:string){
 recentSample(requested);
 if(sources.length>requested||periodicRecordCount(sources)>PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS.records[requested])throw new Error("Sample exceeds bounded analysis limits; nothing was omitted.");
 const ids=new Set<string>(),records=new Set<string>();
 const captured=Date.parse(capturedAt),upTo=(time:string|null)=>time===null||(Number.isFinite(Date.parse(time))&&Date.parse(time)<=captured);
 const clocks=enrichTrades(sources.map(s=>s.trade)),named=namedVersions(sources);
 const trades=sources.map((s,i)=>{
  if(s.trade.account_id!==accountId||s.plan.account_id!==accountId||s.plan.id!==s.trade.id||s.trade.status!=="CLOSED"||s.trade.realized_r===null||!s.trade.exited_at||!Number.isFinite(Date.parse(s.trade.exited_at))||Date.parse(s.trade.exited_at)>captured||ids.has(s.trade.id)||records.has(s.tradeRecordId))throw new Error("Recent trade scope mismatch");
  if(s.strategy.id!==s.plan.strategy_version_id||s.risk.id!==s.plan.risk_plan_version_id)throw new Error("Recent version mismatch");
  if(s.events.some(e=>!Number.isFinite(Date.parse(e.occurred_at))||!upTo(e.occurred_at)||!upTo(e.recorded_at))||s.journal.some(e=>!upTo(e.recordedAt))||!upTo(s.tags?.recordedAt??null))throw new Error("Recent event scope mismatch");
  ids.add(s.trade.id);records.add(s.tradeRecordId);
  return periodicTrade(s,{session:clocks[i].session,weekday:clocks[i].weekday,named});
 });
 const edge=compactEdge(metrics(sources.map(s=>s.trade)));
 return verifiedPeriodicFactsV2("RECENT_TRADES_ANALYSIS",{version:"RECENT_TRADES_FACTS_V2",capturedAt,currency,
  sample:{requested,actual:trades.length,tradeIds:trades.map(t=>t.tradeId),label:edge.sample,fewerThanRequested:trades.length<requested,caveat:(trades.length<requested?"Fewer completed trades are available than requested. ":"")+(trades.length<30?"Small sample: patterns are tentative, not established behavioral conclusions.":"Thirty trades are a limited sample; patterns remain tentative and do not prove behavioral causes."),ordering:"Persisted exit timestamp descending (PostgreSQL microseconds), then plan UUID ascending for exact ties."},
  scope:`Only the selected most recent completed planned trades of this account, their original versions, and the journal entries, events and tags recorded up to the capture time. Live-first and imported trades are not included. No open trades, other account history, screenshots, prior AI output or account balances. Money amounts are in ${currency}. Sample is refreshed on explicit submission; exact included IDs are preserved. ${PERIODIC_RECORD_RULES}`,
  ...snapshotVersions(sources),edge,trades});
}
export type RecentTradesFactsV2=ReturnType<typeof recentTradesContextV2>;
