import "server-only";
import {z} from "zod";
import {ownedWeeklyAccount,loadWeeklyFacts,WeeklyScopeError} from "./weekly-review-source";
import {accountAiAvailability} from "./ai-budget";
import {operationFor} from "@/ai/operations";
import {reservationMicros} from "@/ai/pricing";
import {weeklyReviewOutput} from "@/ai/weekly-review-contract";
import {weeklyPeriod} from "@/ai/weekly-period";
import type {WeeklyReviewFacts} from "@/ai/weekly-review-context";
const factsSchema=z.object({version:z.literal("WEEKLY_REVIEW_FACTS_V1"),period:z.object({startDate:z.string(),endDate:z.string(),start:z.string(),endExclusive:z.string()}),sample:z.object({count:z.number(),label:z.string(),caveat:z.string()}),edge:z.record(z.string(),z.unknown()),trades:z.array(z.record(z.string(),z.unknown()))}).passthrough();
const reviewSchema=z.object({id:z.uuid(),facts:factsSchema,operation:z.object({provider:z.string(),model:z.string(),version:z.string()}),created_at:z.string(),deadline_at:z.string()});
const resultSchema=z.object({review_id:z.uuid(),status:z.enum(["COMPLETED","FAILED"]),interpretation:weeklyReviewOutput.nullable(),error_code:z.string().nullable(),reservation_id:z.uuid().nullable(),created_at:z.string()});
export async function loadWeeklyReviewPanel(accountId:string,day:string,page=0){
 const owner=await ownedWeeklyAccount(accountId),{db,account}=owner,period=weeklyPeriod(day),amount=reservationMicros(undefined,operationFor("WEEKLY_REVIEW"));
 page=Number.isSafeInteger(page)&&page>=0?Math.min(page,10000):0;
 let facts:WeeklyReviewFacts|null=null,scopeError:string|null=null;
 try{facts=await loadWeeklyFacts(owner,period.startDate);}catch(error){scopeError=error instanceof WeeklyScopeError?error.message:"Weekly source records are unavailable. Nothing can be sent.";}
 const base={account,period,amount,facts,scopeError,page};
 try {
  const availability=await accountAiAvailability(account.id,"WEEKLY_REVIEW");
  const q=await db.from("weekly_ai_reviews").select("id,facts,operation,created_at,deadline_at",{count:"exact"}).eq("account_id",account.id).eq("user_id",owner.user.id).eq("week_start",period.startDate).order("created_at",{ascending:false}).order("id",{ascending:false}).range(page*10,page*10+9);
  if(q.error)throw new Error("Weekly history unavailable");
  const requests=z.array(reviewSchema).parse(q.data),ids=requests.map(r=>r.id);
  const [results,reservations]=ids.length?await Promise.all([
   db.from("weekly_ai_review_results").select("review_id,status,interpretation,error_code,reservation_id,created_at").eq("account_id",account.id).in("review_id",ids),
   db.from("ai_request_reservations").select("id,operation_id,reserved_micros").eq("account_id",account.id).eq("operation","WEEKLY_REVIEW").in("operation_id",ids),
  ]):[{data:[],error:null},{data:[],error:null}];
  if(results.error||reservations.error)throw new Error("Weekly history unavailable");
  const outputs=z.array(resultSchema).parse(results.data),holds=z.array(z.object({id:z.uuid(),operation_id:z.uuid(),reserved_micros:z.number()})).parse(reservations.data);
  const usage=holds.length?await db.from("ai_usage_records").select("reservation_id,charged_micros,disposition").eq("account_id",account.id).in("reservation_id",holds.map(r=>r.id)):{data:[],error:null};
  if(usage.error)throw new Error("Weekly accounting unavailable");
  const costs=z.array(z.object({reservation_id:z.uuid(),charged_micros:z.number(),disposition:z.string()})).parse(usage.data);
  const history=requests.map(r=>{const result=outputs.find(x=>x.review_id===r.id)??null,hold=holds.find(x=>x.operation_id===r.id);return {...r,result,accounting:hold?{reservedMicros:hold.reserved_micros,usage:costs.find(c=>c.reservation_id===hold.id)??null}:null};});
  return {...base,availability,history,hasOlder:(q.count??0)>(page+1)*10,error:null};
 }catch{return {...base,availability:{status:"CONFIGURATION_ERROR" as const,message:"Weekly Review is unavailable. Other Trading OS workflows remain available.",deepEnabled:false},history:[],hasOlder:false,error:"Unable to load weekly AI history or configuration. Existing records are preserved; nothing runs automatically."};}
}
export type WeeklyReviewPanelData=Awaited<ReturnType<typeof loadWeeklyReviewPanel>>;
