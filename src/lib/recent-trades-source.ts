import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {journalRow} from "@/domain/analytics";
import {operationFor} from "@/ai/operations";
import type {PeriodicTradeSource} from "@/ai/periodic-facts";
import {periodicRecordCount,PERIODIC_V2_LIMITS} from "@/ai/periodic-limits";
import {recentTradesContextV2,recentSample,type RecentTradesFactsV2} from "@/ai/recent-trades-context";
import {estimateRequest} from "@/ai/request-estimate";
import {loadPeriodicSources,PeriodicRecordsLimitError,periodicAccountRow} from "./periodic-review-source";
export class RecentScopeError extends Error {}
/** Copy when even the smallest sample (10 trades) would not fit one request: no impossible next step is suggested. */
export const RECENT_TOO_LARGE_SMALLEST="Even the 10 most recent trades carry more recorded detail than one analysis can include. Nothing was sent and no record was left out.";
/**
 * Copy when the whole request would not fit the operation's input limit (checked before anything is written): it names
 * the largest smaller sample that fits, the one clear next step, or says that none does.
 */
export function recentTooLarge(requested:10|20|30,fits:10|20|null):string{
 if(requested===10||fits===null)return RECENT_TOO_LARGE_SMALLEST;
 return `The last ${requested} trades carry more recorded detail than one analysis can include, but the last ${fits} fit: choose ${fits} trades. Nothing was sent and no record was left out.`;
}
/**
 * Copy when the sample has more journal entries and events than one analysis of its size may include. Like
 * `recentTooLarge`, it names the largest smaller sample that fits, or, when none does, suggests no impossible step.
 */
export function recentTooManyRecords(requested:10|20|30,fits:10|20|null):string{
 const maxRecords=PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS.records[requested];
 if(requested===10)return `Even the 10 most recent trades have more than ${maxRecords} journal entries and events, more than one analysis can include. Nothing was sent; no record was left out.`;
 if(fits===null)return RECENT_TOO_LARGE_SMALLEST;
 return `The last ${requested} trades have more than ${maxRecords} journal entries and events, more than one analysis of ${requested} trades can include, but the last ${fits} fit: choose ${fits} trades. Nothing was sent; no record was left out.`;
}
export async function ownedRecentAccount(accountId:string){
 const {db,user}=await requireUser();
 const a=await db.from("accounts").select("id,name,currency").eq("id",z.uuid().parse(accountId)).eq("user_id",user.id).maybeSingle();
 if(a.error||!a.data)throw new Error("Account unavailable");
 return {db,user,account:periodicAccountRow.parse(a.data)};
}
/** True when the facts and the whole request built from them fit the operation's bounds (`PERIODIC_V2_LIMITS`, input limit). */
function fitsOneRequest(facts:RecentTradesFactsV2):boolean{
 const operation=operationFor("RECENT_TRADES_ANALYSIS");
 return Buffer.byteLength(JSON.stringify(facts))<=PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS.bytes&&estimateRequest(operation,{context:facts,images:[],prior:[]}).tokens<=operation.maxInputTokens;
}
/** The newest trades of a sample, read with the bound of their own sample size; null when they are above it. */
type SourcesOf=(n:10|20)=>Promise<readonly PeriodicTradeSource[]|null>;
/**
 * The largest smaller sample that would fit one request: within its own record bound and, as facts, within the input
 * limit. The newest N trades are the first N of a larger sample (same order, same capture time), so a sample read in
 * full is cut rather than read again; a sample refused at its record bound is read again for each smaller size.
 */
async function largestFittingSample(accountId:string,requested:10|20|30,sourcesOf:SourcesOf,capturedAt:string,currency:string):Promise<10|20|null>{
 const limits=PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS;
 for(const n of [20,10] as const){
  if(n>=requested)continue;
  const sources=await sourcesOf(n);
  if(sources&&periodicRecordCount(sources)<=limits.records[n]&&fitsOneRequest(recentTradesContextV2(accountId,n,[...sources],capturedAt,currency)))return n;
 }
 return null;
}
/**
 * RECENT_TRADES_FACTS_V2 of the latest N completed planned trades with their V2 journal entries and tags (spec §11.5:
 * live-first and imported trades have no locked plan and are not part of the sample). Refuses with RecentScopeError,
 * before anything is written or reserved, when the sample is above its record bound or the whole request would not
 * fit; either refusal names the largest smaller sample that fits.
 */
export async function loadRecentFacts(owner:Awaited<ReturnType<typeof ownedRecentAccount>>,sample:unknown=20){
 const {db,user,account}=owner,requested=recentSample(sample),capturedAt=new Date().toISOString(),limits=PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS;
 const q=await db.from("journal_analytics").select("*",{count:"exact"}).eq("account_id",account.id).eq("status","CLOSED").not("realized_r","is",null).lte("exited_at",capturedAt).order("exited_at",{ascending:false}).order("id",{ascending:true}).limit(requested);
 if(q.error)throw new Error("Recent trades unavailable");
 const trades=z.array(journalRow).parse(q.data);
 const eligibleCount=z.number().int().min(trades.length).parse(q.count);
 const read=(n:10|20|30)=>loadPeriodicSources({db,userId:user.id,accountId:account.id,trades:trades.slice(0,n),scope:{kind:"UP_TO",at:capturedAt},maxRecords:limits.records[n],legacyTags:true,recordsMessage:recentTooManyRecords(n,null)});
 let sources:Awaited<ReturnType<typeof loadPeriodicSources>>;
 try {
  sources=await read(requested);
 }catch(error){
  if(!(error instanceof PeriodicRecordsLimitError))throw error;
  const readSmaller:SourcesOf=n=>read(n).catch((smaller:unknown)=>{if(smaller instanceof PeriodicRecordsLimitError)return null;throw smaller;});
  throw new RecentScopeError(recentTooManyRecords(requested,await largestFittingSample(account.id,requested,readSmaller,capturedAt,account.currency)));
 }
 const facts=recentTradesContextV2(account.id,requested,sources,capturedAt,account.currency);
 if(trades.length&&!fitsOneRequest(facts)){
  const cut:SourcesOf=async n=>sources.slice(0,n);
  throw new RecentScopeError(recentTooLarge(requested,await largestFittingSample(account.id,requested,cut,capturedAt,account.currency)));
 }
 return {facts,eligibleCount};
}
