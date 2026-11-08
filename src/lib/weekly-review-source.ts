import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {journalRow} from "@/domain/analytics";
import {operationFor} from "@/ai/operations";
import {periodicRecordCount,PERIODIC_V2_LIMITS} from "@/ai/periodic-limits";
import {plural} from "@/domain/format";
import {estimateRequest} from "@/ai/request-estimate";
import {weeklyPeriod} from "@/ai/weekly-period";
import {weeklyReviewContextV2} from "@/ai/weekly-review-context";
import {loadPeriodicSources,PeriodicRecordsLimitError,periodicAccountRow} from "./periodic-review-source";
export class WeeklyScopeError extends Error {}
/**
 * What a trader can still do with a week one weekly review cannot take: a week is reviewed whole or not at all (spec
 * §11.5, no subset), and every closed trade of it can still be reviewed on its own. The only step every refusal names.
 */
export const WEEKLY_NEXT_STEP="You can still review each of its trades with Review this trade on the trade's page.";
const {trades:MAX_TRADES,records:MAX_RECORDS}=PERIODIC_V2_LIMITS.WEEKLY_REVIEW;
/** Copy for a week above the trade bound, a rule of the review (read as one row more than the bound; nothing else is read). */
export const WEEKLY_TOO_MANY_TRADES=`This week has more than ${MAX_TRADES} completed trades, and a weekly review covers at most ${MAX_TRADES}. Nothing was sent and no trade was left out. ${WEEKLY_NEXT_STEP}`;
/** Copy for a week above the record bound, a rule of the review: how much of it would fit is not claimed. */
export const WEEKLY_TOO_MANY_RECORDS=`This week's trades have more than ${MAX_RECORDS} journal entries and events, and a weekly review reads at most ${MAX_RECORDS}. Nothing was sent and no record was left out. ${WEEKLY_NEXT_STEP}`;
/**
 * Copy when a week within the bounds would not fit the operation's input limit as one request (checked before anything
 * is written or reserved): what the week holds, why it is too much, and the next step.
 */
export function weeklyTooLarge(trades:number,records:number):string{
 const recorded=records===1?"1 journal entry or event":`${records} journal entries and events`;
 return `This week's ${plural(trades,"trade")} with ${recorded} hold more text than one weekly review can include; long theses and notes take more room. Nothing was sent and no record was left out. ${WEEKLY_NEXT_STEP}`;
}
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
 if(trades.length>limits.trades)throw new WeeklyScopeError(WEEKLY_TOO_MANY_TRADES);
 let sources:Awaited<ReturnType<typeof loadPeriodicSources>>;
 try {
  sources=await loadPeriodicSources({db,userId:user.id,accountId:account.id,trades,scope:{kind:"WITHIN",start:period.start,endExclusive:period.endExclusive},maxRecords:limits.records,legacyTags:false,
   recordsMessage:WEEKLY_TOO_MANY_RECORDS});
 }catch(error){if(error instanceof PeriodicRecordsLimitError)throw new WeeklyScopeError(error.message);throw error;}
 const facts=weeklyReviewContextV2(account.id,day,sources,capturedAt,account.currency);
 const tooLarge=()=>new WeeklyScopeError(weeklyTooLarge(trades.length,periodicRecordCount(sources)));
 if(Buffer.byteLength(JSON.stringify(facts))>limits.bytes)throw tooLarge();
 if(trades.length&&estimateRequest(operationFor("WEEKLY_REVIEW"),{context:facts,images:[],prior:[]}).tokens>operationFor("WEEKLY_REVIEW").maxInputTokens)throw tooLarge();
 return facts;
}
