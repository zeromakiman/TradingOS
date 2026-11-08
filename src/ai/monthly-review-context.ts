import {withOperationSources,verifiedPeriodicFactsV2} from "./citation-sources";
import {metrics,enrichTrades,groups,type JournalTrade} from "@/domain/analytics";
import {tradeReviewContext,type ReviewEvent} from "./trade-review-context";
import {monthlyPeriod} from "./monthly-period";
import {operationFor} from "./operations";
import {namedVersions,PERIODIC_RECORD_RULES,periodicTrade,snapshotVersions,versionIdentities,type PeriodicTradeSource} from "./periodic-facts";
import {compactEdge,periodicRecordCount,PERIODIC_V2_LIMITS} from "./periodic-limits";
import {estimateRequest} from "./request-estimate";
/** Bounds of the V1 facts (MONTHLY_REVIEW_FACTS_V1, kept for stored history). New requests use PERIODIC_V2_LIMITS. */
export const MONTHLY_LIMITS=Object.freeze({trades:120,events:500,bytes:128000,detailedTrades:30,detailedBytes:96000});
type TradeContext=Parameters<typeof tradeReviewContext>;
export interface MonthlyTradeSource {plan:TradeContext[0];trade:JournalTrade;strategy:TradeContext[2];risk:TradeContext[3];events:ReviewEvent[]}
/** MONTHLY_REVIEW_FACTS_V1: the original facts of stored reviews. */
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
 const full=withOperationSources("MONTHLY_REVIEW",{...base,mode:"DETAILED",scope:"All selected-month completed trades, original plans/versions and executions. Original plan or entry may precede the month. Notes/events/tags must have occurred AND been recorded within the month. No latest out-of-period tags, screenshots, prior AI outputs, balances or other months.",trades:detailed,strategyVersions:[...strategies.values()],riskVersions:[...risks.values()],sourceRefs:["period","sample","edge","models","sessions",...detailed.map(t=>"trade:"+t.tradeId)]});
 if(detailed.length<=MONTHLY_LIMITS.detailedTrades&&new TextEncoder().encode(JSON.stringify(full)).length<=MONTHLY_LIMITS.detailedBytes)return full;
 // Explicit deterministic aggregation of the entire sample, never a silent subset or AI-generated summary.
 return withOperationSources("MONTHLY_REVIEW",{...base,mode:"DETERMINISTIC SUMMARY",scope:"All selected trades contribute to unchanged domain EDGE/model/session metrics; exact IDs and original version identities are retained. Individual plans, executions, rules, narrative, notes and tags are omitted in this bounded mode. Rule/process/behavioral causes and improvement cannot be inferred from outcomes. No screenshots, prior AI outputs, balances or other months.",
  trades:detailed.map(t=>({tradeId:t.tradeId})),strategyVersions:[...strategies.values()].map(s=>({id:s.id,version:s.version})),riskVersions:[...risks.values()].map(r=>({id:r.id,version:r.version})),
  omitted:{individualTradeDetails:detailed.length,eventDetails:sources.reduce((n,s)=>n+s.events.length,0),strategyDefinitions:strategies.size,riskDefinitions:risks.size},sourceRefs:["period","sample","edge","models","sessions"]});
}
export type MonthlyReviewFacts=ReturnType<typeof monthlyReviewContext>;

/** How many journal entries and events of the month the deterministic summary leaves out (it never reads their content). */
export interface MonthlyRecordCounts {journalEntries:number;events:number}
type VersionIdentities=ReturnType<typeof versionIdentities>;

/** Period, exact sample and unchanged deterministic metrics of the month's completed planned trades (both modes). */
function monthlyBaseV2(accountId:string,month:string,trades:readonly JournalTrade[],capturedAt:string,currency:string){
 const period=monthlyPeriod(month),ids=new Set<string>();
 if(trades.length>PERIODIC_V2_LIMITS.MONTHLY_REVIEW.trades)throw new Error("Month exceeds bounded review limits; nothing was sent.");
 const within=(time:string)=>Number.isFinite(Date.parse(time))&&Date.parse(time)>=Date.parse(period.start)&&Date.parse(time)<Date.parse(period.endExclusive);
 for(const t of trades){
  if(t.account_id!==accountId||t.status!=="CLOSED"||t.realized_r===null||!t.exited_at||!within(t.exited_at)||ids.has(t.id))throw new Error("Monthly trade scope mismatch");
  ids.add(t.id);
 }
 const enriched=enrichTrades([...trades]);
 const edge=compactEdge(metrics([...trades])),breakdowns={entryModels:groups(enriched,t=>t.entry_model,["OB_FIRST_TOUCH","OTE"]).map(group=>compactEdge(group)),sessions:groups(enriched,t=>t.session).map(group=>compactEdge(group))};
 const sample={count:edge.completed,tradeIds:[...ids],label:edge.sample,caveat:edge.completed<30?"Small sample: observations are tentative and cannot establish reliable recurring patterns or improvement versus unprovided months.":"One selected month cannot establish improvement versus unprovided months or prove behavioral causes."};
 return {within,enriched,base:{version:"MONTHLY_REVIEW_FACTS_V2",capturedAt,period,currency,sample,edge,breakdowns}};
}

/** Explicit deterministic aggregation of the entire sample, never a silent subset or AI-generated summary. */
function monthlySummaryV2(base:ReturnType<typeof monthlyBaseV2>["base"],versions:VersionIdentities,counts:MonthlyRecordCounts){
 return verifiedPeriodicFactsV2("MONTHLY_REVIEW",{...base,mode:"DETERMINISTIC SUMMARY" as const,scope:"All selected completed planned trades contribute to unchanged domain EDGE/model/session metrics; exact IDs and original version identities are retained. Individual plans, executions, rules, narrative, journal entries, events and tags are omitted in this bounded mode. Rule/process/behavioral causes and improvement cannot be inferred from outcomes. Live-first and imported trades are not included. No screenshots, prior AI outputs, balances or other months.",
  trades:base.sample.tradeIds.map(tradeId=>({tradeId})),strategyVersions:versions.strategyVersions,riskVersions:versions.riskVersions,
  omitted:{individualTradeDetails:base.sample.tradeIds.length,journalEntries:counts.journalEntries,eventDetails:counts.events,strategyDefinitions:versions.strategyVersions.length,riskDefinitions:versions.riskVersions.length}});
}

/**
 * MONTHLY_REVIEW_FACTS_V2 (new requests). DETAILED lists every completed planned trade of the month as compact
 * deterministic facts with the journal entries, events and tags that occurred AND were recorded within the month.
 * When the month has more trades or records than one detailed review covers, or the whole request would not fit the
 * operation's input limit, the month is reviewed in DETERMINISTIC SUMMARY mode: every trade still counts toward the
 * unchanged EDGE/model/session metrics and its id is kept, and the omitted detail is stated explicitly. The summary
 * uses no record content, so no record bound applies to it.
 */
export function monthlyReviewContextV2(accountId:string,month:string,sources:PeriodicTradeSource[],capturedAt:string,currency:string){
 const limits=PERIODIC_V2_LIMITS.MONTHLY_REVIEW,records=new Set<string>();
 const {within,enriched,base}=monthlyBaseV2(accountId,month,sources.map(s=>s.trade),capturedAt,currency),named=namedVersions(sources);
 const detailed=sources.map((s,i)=>{
  if(s.plan.id!==s.trade.id||s.plan.account_id!==accountId||records.has(s.tradeRecordId))throw new Error("Monthly trade scope mismatch");
  if(s.strategy.id!==s.plan.strategy_version_id||s.risk.id!==s.plan.risk_plan_version_id)throw new Error("Monthly version mismatch");
  if(s.events.some(e=>!within(e.occurred_at)||!within(e.recorded_at))||s.journal.some(e=>!within(e.recordedAt))||(s.tags!==null&&(s.tags.recordedAt===null||!within(s.tags.recordedAt))))throw new Error("Monthly event scope mismatch");
  records.add(s.tradeRecordId);
  return periodicTrade(s,{session:enriched[i].session,weekday:enriched[i].weekday,named});
 });
 const counts={journalEntries:sources.reduce((n,s)=>n+s.journal.length,0),events:sources.reduce((n,s)=>n+s.events.length,0)};
 if(detailed.length<=limits.detailedTrades&&periodicRecordCount(sources)<=limits.detailedRecords){
  const full=verifiedPeriodicFactsV2("MONTHLY_REVIEW",{...base,mode:"DETAILED" as const,scope:`All selected-month completed planned trades, original plans/versions and executions. Original plan or entry may precede the month. Journal entries, events and tags must have occurred AND been recorded within the month. Live-first and imported trades are not included. No latest out-of-period tags, screenshots, prior AI outputs, balances or other months. Money amounts are in ${currency}. ${PERIODIC_RECORD_RULES}`,trades:detailed,...snapshotVersions(sources)});
  if(Buffer.byteLength(JSON.stringify(full))<=limits.bytes&&estimateRequest(operationFor("MONTHLY_REVIEW"),{context:full,images:[],prior:[]}).tokens<=operationFor("MONTHLY_REVIEW").maxInputTokens)return full;
 }
 return monthlySummaryV2(base,versionIdentities(sources),counts);
}
export type MonthlyReviewFactsV2=ReturnType<typeof monthlyReviewContextV2>;

/**
 * MONTHLY_REVIEW_FACTS_V2 in DETERMINISTIC SUMMARY mode from the month's `journal_analytics` rows (which name each
 * trade's original versions) and the counts of its journal entries and events: the same facts the summary built from
 * fully loaded sources carries, for a month whose records are not read.
 */
export function monthlySummaryContextV2(accountId:string,month:string,trades:readonly JournalTrade[],counts:MonthlyRecordCounts,capturedAt:string,currency:string):MonthlyReviewFactsV2{
 const {base}=monthlyBaseV2(accountId,month,trades,capturedAt,currency);
 const versions=versionIdentities(trades.map(t=>({strategy:{id:t.strategy_version_id,version:t.strategy_version},risk:{id:t.risk_plan_version_id,version:t.risk_plan_version}})));
 return monthlySummaryV2(base,versions,counts);
}
