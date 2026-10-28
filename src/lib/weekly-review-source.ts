import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {journalRow} from "@/domain/analytics";
import {operationFor} from "@/ai/operations";
import {PERIODIC_V2_LIMITS} from "@/ai/periodic-limits";
import {estimateRequest} from "@/ai/request-estimate";
import {weeklyPeriod} from "@/ai/weekly-period";
import {weeklyReviewContextV2} from "@/ai/weekly-review-context";
import {loadPeriodicSources,PeriodicRecordsLimitError,periodicAccountRow} from "./periodic-review-source";
export class WeeklyScopeError extends Error {}
/** Copy when the whole request would not fit the operation's input limit (checked before anything is written). */
export const WEEKLY_TOO_LARGE="This week has more recorded detail than one review can analyse. Nothing was sent and no record was left out.";
export async function ownedWeeklyAccount(accountId:string){
 const {db,user}=await requireUser();
 const a=await db.from("accounts").select("id,name,currency").eq("id",z.uuid().parse(accountId)).eq("user_id",user.id).maybeSingle();
 if(a.error||!a.data)throw new Error("Account unavailable");
 return {db,user,account:periodicAccountRow.parse(a.data)};
}
/**
 * WEEKLY_REVIEW_FACTS_V2 of one completed Monday week (fixed UTC−5): its completed planned trades by exit time with
 * the journal entries, events and tags that occurred and were recorded within the week. Refuses with WeeklyScopeError,
 * before anything is written or reserved, when the week is above a bound or the whole request would not fit.
 */
export async function loadWeeklyFacts(owner:Awaited<ReturnType<typeof ownedWeeklyAccount>>,day:string){
 const {db,user,account}=owner,period=weeklyPeriod(day),capturedAt=new Date().toISOString(),limits=PERIODIC_V2_LIMITS.WEEKLY_REVIEW;
 if(Date.parse(period.endExclusive)>Date.parse(capturedAt))throw new WeeklyScopeError("Choose a completed week. Weekly Review starts after Sunday ends in fixed UTC−5.");
 const q=await db.from("journal_analytics").select("*").eq("account_id",account.id).eq("status","CLOSED").gte("exited_at",period.start).lt("exited_at",period.endExclusive).order("exited_at").order("id").limit(limits.trades+1);
 if(q.error)throw new Error("Weekly trades unavailable");
 const trades=z.array(journalRow).parse(q.data);
 if(trades.length>limits.trades)throw new WeeklyScopeError(`This week has more than ${limits.trades} completed trades, the most one review can analyse. Nothing was sent; no trades were silently omitted.`);
 let sources:Awaited<ReturnType<typeof loadPeriodicSources>>;
 try {
  sources=await loadPeriodicSources({db,userId:user.id,accountId:account.id,trades,scope:{kind:"WITHIN",start:period.start,endExclusive:period.endExclusive},maxRecords:limits.records,legacyTags:false,
   recordsMessage:`This week has more than ${limits.records} journal entries and events, more than one review can include. Nothing was sent; no record was left out.`});
 }catch(error){if(error instanceof PeriodicRecordsLimitError)throw new WeeklyScopeError(error.message);throw error;}
 const facts=weeklyReviewContextV2(account.id,day,sources,capturedAt,account.currency);
 if(Buffer.byteLength(JSON.stringify(facts))>limits.bytes)throw new WeeklyScopeError(WEEKLY_TOO_LARGE);
 if(trades.length&&estimateRequest(operationFor("WEEKLY_REVIEW"),{context:facts,images:[],prior:[]}).tokens>operationFor("WEEKLY_REVIEW").maxInputTokens)throw new WeeklyScopeError(WEEKLY_TOO_LARGE);
 return facts;
}
