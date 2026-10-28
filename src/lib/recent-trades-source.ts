import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {journalRow} from "@/domain/analytics";
import {operationFor} from "@/ai/operations";
import {PERIODIC_V2_LIMITS} from "@/ai/periodic-limits";
import {recentTradesContextV2,recentSample} from "@/ai/recent-trades-context";
import {estimateRequest} from "@/ai/request-estimate";
import {loadPeriodicSources,PeriodicRecordsLimitError,periodicAccountRow} from "./periodic-review-source";
export class RecentScopeError extends Error {}
/** Copy when the whole request would not fit the operation's input limit (checked before anything is written). */
export const RECENT_TOO_LARGE="This sample is too large to analyse in one request. Choose fewer trades. Nothing was sent and no record was left out.";
/** The same for the smallest sample (10 trades), which cannot be made smaller: no impossible next step is suggested. */
export const RECENT_TOO_LARGE_SMALLEST="Even the 10 most recent trades carry more recorded detail than one analysis can include. Nothing was sent and no record was left out.";
/** Copy when the sample has more journal entries and events than one analysis of its size may include. */
function recordsMessage(requested:10|20|30,maxRecords:number){
 return requested===10
  ?`Even the 10 most recent trades have more than ${maxRecords} journal entries and events, more than one analysis can include. Nothing was sent; no record was left out.`
  :`The last ${requested} trades have more than ${maxRecords} journal entries and events, more than one analysis of ${requested} trades can include. Choose fewer trades. Nothing was sent; no record was left out.`;
}
export async function ownedRecentAccount(accountId:string){
 const {db,user}=await requireUser();
 const a=await db.from("accounts").select("id,name,currency").eq("id",z.uuid().parse(accountId)).eq("user_id",user.id).maybeSingle();
 if(a.error||!a.data)throw new Error("Account unavailable");
 return {db,user,account:periodicAccountRow.parse(a.data)};
}
/**
 * RECENT_TRADES_FACTS_V2 of the latest N completed planned trades with their V2 journal entries and tags (spec §11.5:
 * live-first and imported trades have no locked plan and are not part of the sample). Refuses with RecentScopeError,
 * before anything is written or reserved, when the sample is above a bound or the whole request would not fit.
 */
export async function loadRecentFacts(owner:Awaited<ReturnType<typeof ownedRecentAccount>>,sample:unknown=20){
 const {db,user,account}=owner,requested=recentSample(sample),capturedAt=new Date().toISOString(),limits=PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS;
 const q=await db.from("journal_analytics").select("*",{count:"exact"}).eq("account_id",account.id).eq("status","CLOSED").not("realized_r","is",null).lte("exited_at",capturedAt).order("exited_at",{ascending:false}).order("id",{ascending:true}).limit(requested);
 if(q.error)throw new Error("Recent trades unavailable");
 const trades=z.array(journalRow).parse(q.data);
 const eligibleCount=z.number().int().min(trades.length).parse(q.count);
 let sources:Awaited<ReturnType<typeof loadPeriodicSources>>;
 try {
  const maxRecords=limits.records[requested];
  sources=await loadPeriodicSources({db,userId:user.id,accountId:account.id,trades,scope:{kind:"UP_TO",at:capturedAt},maxRecords,legacyTags:true,recordsMessage:recordsMessage(requested,maxRecords)});
 }catch(error){if(error instanceof PeriodicRecordsLimitError)throw new RecentScopeError(error.message);throw error;}
 const facts=recentTradesContextV2(account.id,requested,sources,capturedAt,account.currency);
 const tooLarge=requested===10?RECENT_TOO_LARGE_SMALLEST:RECENT_TOO_LARGE;
 if(Buffer.byteLength(JSON.stringify(facts))>limits.bytes)throw new RecentScopeError(tooLarge);
 if(trades.length&&estimateRequest(operationFor("RECENT_TRADES_ANALYSIS"),{context:facts,images:[],prior:[]}).tokens>operationFor("RECENT_TRADES_ANALYSIS").maxInputTokens)throw new RecentScopeError(tooLarge);
 return {facts,eligibleCount};
}
