import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {journalRow} from "@/domain/analytics";
import {monthlyPeriod} from "@/ai/monthly-period";
import {monthlyReviewContextV2,monthlySummaryContextV2,type MonthlyReviewFactsV2} from "@/ai/monthly-review-context";
import {operationFor} from "@/ai/operations";
import {PERIODIC_V2_LIMITS} from "@/ai/periodic-limits";
import {estimateRequest} from "@/ai/request-estimate";
import {countPeriodicRecords,loadPeriodicSources,PeriodicRecordsLimitError,periodicAccountRow,type RecordScope} from "./periodic-review-source";
export class MonthlyScopeError extends Error {}
/** What a trader can still do with a month one monthly review cannot take: every closed trade can still be reviewed on its own. */
export const MONTHLY_NEXT_STEP="You can still review each of its trades with Review this trade on the trade's page.";
/** Copy for a month above the trade bound (also the database's bound), a rule of the review; nothing else is read. */
export const MONTHLY_TOO_MANY_TRADES=`This month has more than ${PERIODIC_V2_LIMITS.MONTHLY_REVIEW.trades} completed trades, and a monthly review covers at most ${PERIODIC_V2_LIMITS.MONTHLY_REVIEW.trades}. Nothing was sent and no trade was left out. ${MONTHLY_NEXT_STEP}`;
/** Copy when even the deterministic summary would not fit the operation's input limit (not reached within the trade bound). */
export const MONTHLY_TOO_LARGE=`This month is too large to review, even as a summary of its results. Nothing was sent and no trade was left out. ${MONTHLY_NEXT_STEP}`;
export async function ownedMonthlyAccount(accountId:string){
 const {db,user}=await requireUser();
 const a=await db.from("accounts").select("id,name,currency").eq("id",z.uuid().parse(accountId)).eq("user_id",user.id).maybeSingle();
 if(a.error||!a.data)throw new Error("Account unavailable");
 return {db,user,account:periodicAccountRow.parse(a.data)};
}
/**
 * MONTHLY_REVIEW_FACTS_V2 of one completed calendar month (fixed UTC−5): detailed, or the explicit deterministic
 * summary when the month is larger than one detailed review (src/ai/monthly-review-context.ts). A month that may be
 * detailed is read with the detailed record bound; a month above it (more trades or more records) is summarized from
 * its trades and the counts of its journal entries and events, which are never read. Refuses with MonthlyScopeError,
 * before anything is written or reserved, when even the summary would not fit.
 */
export async function loadMonthlyFacts(owner:Awaited<ReturnType<typeof ownedMonthlyAccount>>,month:string){
 const {db,user,account}=owner,period=monthlyPeriod(month),capturedAt=new Date().toISOString(),limits=PERIODIC_V2_LIMITS.MONTHLY_REVIEW;
 if(Date.parse(period.endExclusive)>Date.parse(capturedAt))throw new MonthlyScopeError("Choose a completed month. Monthly Review starts at the next first day, 00:00 fixed UTC−5.");
 const q=await db.from("journal_analytics").select("*").eq("account_id",account.id).eq("status","CLOSED").gte("exited_at",period.start).lt("exited_at",period.endExclusive).order("exited_at").order("id").limit(limits.trades+1);
 if(q.error)throw new Error("Monthly trades unavailable");
 const trades=z.array(journalRow).parse(q.data);
 if(trades.length>limits.trades)throw new MonthlyScopeError(MONTHLY_TOO_MANY_TRADES);
 const scope:RecordScope={kind:"WITHIN",start:period.start,endExclusive:period.endExclusive};
 let facts:MonthlyReviewFactsV2|null=null;
 if(trades.length<=limits.detailedTrades){
  try {
   facts=monthlyReviewContextV2(account.id,month,await loadPeriodicSources({db,userId:user.id,accountId:account.id,trades,scope,maxRecords:limits.detailedRecords,legacyTags:false,
    recordsMessage:`This month has more than ${limits.detailedRecords} journal entries and events, more than one detailed review includes.`}),capturedAt,account.currency);
  }catch(error){if(!(error instanceof PeriodicRecordsLimitError))throw error;}
 }
 facts??=monthlySummaryContextV2(account.id,month,trades,await countPeriodicRecords({db,userId:user.id,accountId:account.id,trades,scope}),capturedAt,account.currency);
 if(Buffer.byteLength(JSON.stringify(facts))>limits.bytes)throw new MonthlyScopeError(MONTHLY_TOO_LARGE);
 if(trades.length&&estimateRequest(operationFor("MONTHLY_REVIEW"),{context:facts,images:[],prior:[]}).tokens>operationFor("MONTHLY_REVIEW").maxInputTokens)throw new MonthlyScopeError(MONTHLY_TOO_LARGE);
 return facts;
}
