import "server-only";
import {z} from "zod";
import {ownedRecentAccount,loadRecentFacts,RecentScopeError} from "./recent-trades-source";
import {accountAiAvailability} from "./ai-budget";
import {operationFor} from "@/ai/operations";
import {reservationMicros} from "@/ai/pricing";
import {recentTradesOutput} from "@/ai/recent-trades-contract";
import {recentSample} from "@/ai/recent-trades-context";
import type {RecentTradesFacts} from "@/ai/recent-trades-context";
const factsSchema=z.object({version:z.literal("RECENT_TRADES_FACTS_V1"),sample:z.object({requested:z.number(),actual:z.number(),tradeIds:z.array(z.uuid()),label:z.string(),caveat:z.string()}),edge:z.record(z.string(),z.unknown()),trades:z.array(z.record(z.string(),z.unknown()))}).passthrough();
const reviewSchema=z.object({id:z.uuid(),facts:factsSchema,operation:z.object({provider:z.string(),model:z.string(),version:z.string()}),created_at:z.string(),deadline_at:z.string()});
const resultSchema=z.object({review_id:z.uuid(),status:z.enum(["COMPLETED","FAILED"]),interpretation:recentTradesOutput.nullable(),error_code:z.string().nullable(),reservation_id:z.uuid().nullable(),created_at:z.string()});
export async function loadRecentTradesPanel(accountId:string,sample:unknown=20,page=0){
 const owner=await ownedRecentAccount(accountId),{db,account}=owner,requested=recentSample(sample),amount=reservationMicros(undefined,operationFor("RECENT_TRADES_ANALYSIS"));
 page=Number.isSafeInteger(page)&&page>=0?Math.min(page,10000):0;
 let eligibleCount:number|null=null,facts:RecentTradesFacts|null=null,scopeError:string|null=null;
 try{const loaded=await loadRecentFacts(owner,requested);facts=loaded.facts;eligibleCount=loaded.eligibleCount;}catch(error){scopeError=error instanceof RecentScopeError?error.message:"Recent source records are unavailable. Nothing can be sent.";}
 const base={account,requested,amount,facts,eligibleCount,scopeError,page};
 try {
  const availability=await accountAiAvailability(account.id,"RECENT_TRADES_ANALYSIS");
  const q=await db.from("recent_ai_analyses").select("id,facts,operation,created_at,deadline_at",{count:"exact"}).eq("account_id",account.id).eq("user_id",owner.user.id).eq("requested_sample",requested).order("created_at",{ascending:false}).order("id",{ascending:false}).range(page*10,page*10+9);
  if(q.error)throw new Error("Recent history unavailable");
  const requests=z.array(reviewSchema).parse(q.data),ids=requests.map(r=>r.id);
  const [results,reservations]=ids.length?await Promise.all([
   db.from("recent_ai_analysis_results").select("review_id,status,interpretation,error_code,reservation_id,created_at").eq("account_id",account.id).in("review_id",ids),
   db.from("ai_request_reservations").select("id,operation_id,reserved_micros").eq("account_id",account.id).eq("operation","RECENT_TRADES_ANALYSIS").in("operation_id",ids),
  ]):[{data:[],error:null},{data:[],error:null}];
  if(results.error||reservations.error)throw new Error("Recent history unavailable");
  const outputs=z.array(resultSchema).parse(results.data),holds=z.array(z.object({id:z.uuid(),operation_id:z.uuid(),reserved_micros:z.number()})).parse(reservations.data);
  const usage=holds.length?await db.from("ai_usage_records").select("reservation_id,charged_micros,disposition").eq("account_id",account.id).in("reservation_id",holds.map(r=>r.id)):{data:[],error:null};
  if(usage.error)throw new Error("Recent accounting unavailable");
  const costs=z.array(z.object({reservation_id:z.uuid(),charged_micros:z.number(),disposition:z.string()})).parse(usage.data);
  const history=requests.map(r=>{const result=outputs.find(x=>x.review_id===r.id)??null,hold=holds.find(x=>x.operation_id===r.id);return {...r,result,accounting:hold?{reservedMicros:hold.reserved_micros,usage:costs.find(c=>c.reservation_id===hold.id)??null}:null};});
  return {...base,availability,history,hasOlder:(q.count??0)>(page+1)*10,error:null};
 }catch{return {...base,availability:{status:"CONFIGURATION_ERROR" as const,message:"Recent-Trades Analysis is unavailable. Other Trading OS workflows remain available.",deepEnabled:false},history:[],hasOlder:false,error:"Unable to load recent AI history or configuration. Existing records are preserved; nothing runs automatically."};}
}
export type RecentTradesPanelData=Awaited<ReturnType<typeof loadRecentTradesPanel>>;
