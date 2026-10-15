import "server-only";
import { z } from "zod";
import { requireUser } from "./supabase/server";
import { PLAN_SELECT,planRow } from "./data";
import { journalRow } from "@/domain/analytics";
import { accountAiAvailability } from "./ai-budget";
import { operationFor } from "@/ai/operations";
import { operationPricing,reservationMicros } from "@/ai/pricing";
import { tradeReviewOutput } from "@/ai/trade-review-contract";

type Db=Awaited<ReturnType<typeof requireUser>>["db"];
export const evidenceSchema=z.object({id:z.uuid(),role:z.string(),original_filename:z.string(),storage_path:z.string(),mime_type:z.string(),byte_size:z.number(),sha256:z.string()});
export async function reviewEvidence(db:Db,planId:string) {
 const link=await db.from("setup_locks").select("proposal_id").eq("plan_id",planId).maybeSingle();
 if(link.error)throw new Error("Evidence unavailable");
 if(!link.data)return [];
 const proposalId=z.uuid().parse(link.data.proposal_id);
 const [images,removals]=await Promise.all([
  db.from("setup_screenshots").select("id,role,original_filename,storage_path,mime_type,byte_size,sha256").eq("proposal_id",proposalId).order("uploaded_at"),
  db.from("setup_screenshot_removals").select("screenshot_id").eq("proposal_id",proposalId),
 ]);
 if(images.error||removals.error)throw new Error("Evidence unavailable");
 const removed=new Set(z.array(z.object({screenshot_id:z.uuid()})).parse(removals.data).map(x=>x.screenshot_id));
 return z.array(evidenceSchema).parse(images.data).filter(x=>!removed.has(x.id));
}
export async function ownedReviewTrade(planId:string) {
 const {db,user}=await requireUser();
 const p=await db.from("trade_plans").select(PLAN_SELECT).eq("id",z.uuid().parse(planId)).eq("user_id",user.id).maybeSingle();
 if(p.error||!p.data)throw new Error("Trade unavailable");
 const plan=planRow.parse(p.data);
 const t=await db.from("journal_analytics").select("*").eq("id",plan.id).eq("account_id",plan.account_id).single();
 if(t.error)throw new Error("Trade unavailable");
 return {db,user,plan,trade:journalRow.parse(t.data)};
}
const reviewSchema=z.object({id:z.uuid(),facts:z.record(z.string(),z.unknown()),operation:z.object({provider:z.string(),model:z.string(),version:z.string()}),created_at:z.string(),deadline_at:z.string()});
const resultSchema=z.object({review_id:z.uuid(),status:z.enum(["COMPLETED","FAILED"]),interpretation:tradeReviewOutput.nullable(),error_code:z.string().nullable(),reservation_id:z.uuid().nullable(),created_at:z.string()});
export async function loadTradeReviewPanel(planId:string,page=0) {
 const {db,plan,trade}=await ownedReviewTrade(planId),operation=operationFor("REVIEW_TRADE");
 let amount=0;
 try {
  amount=reservationMicros(operationPricing(operation),operation);
  const availability=await accountAiAvailability(plan.account_id,"REVIEW_TRADE");
  const evidence=(await reviewEvidence(db,plan.id)).map(({id,role,original_filename})=>({id,role,label:original_filename}));
  const q=await db.from("trade_ai_reviews").select("id,facts,operation,created_at,deadline_at",{count:"exact"}).eq("plan_id",plan.id).order("created_at",{ascending:false}).order("id",{ascending:false}).range(page*10,page*10+9);
  if(q.error)throw new Error("Review history unavailable");
  const requests=z.array(reviewSchema).parse(q.data),ids=requests.map(r=>r.id);
  const [results,reservations]=ids.length?await Promise.all([
   db.from("trade_ai_review_results").select("review_id,status,interpretation,error_code,reservation_id,created_at").in("review_id",ids),
   db.from("ai_request_reservations").select("id,operation_id,reserved_micros").eq("operation","REVIEW_TRADE").in("operation_id",ids),
  ]):[{data:[],error:null},{data:[],error:null}];
  if(results.error||reservations.error)throw new Error("Review history unavailable");
  const outputs=z.array(resultSchema).parse(results.data);
  const holds=z.array(z.object({id:z.uuid(),operation_id:z.uuid(),reserved_micros:z.number()})).parse(reservations.data);
  const usage=holds.length?await db.from("ai_usage_records").select("reservation_id,charged_micros,disposition").in("reservation_id",holds.map(r=>r.id)):{data:[],error:null};
  if(usage.error)throw new Error("Review accounting unavailable");
  const costs=z.array(z.object({reservation_id:z.uuid(),charged_micros:z.number(),disposition:z.string()})).parse(usage.data);
  const history=requests.map(r=>{const result=outputs.find(x=>x.review_id===r.id)??null,hold=holds.find(x=>x.operation_id===r.id);return {...r,result,accounting:hold?{reservedMicros:hold.reserved_micros,usage:costs.find(c=>c.reservation_id===hold.id)??null}:null};});
  return {availability,amount,evidence,history,closed:trade.status==="CLOSED",page,hasOlder:(q.count??0)>(page+1)*10,error:null};
 } catch {return {availability:{status:"CONFIGURATION_ERROR" as const,message:"Trade review is unavailable. Other trade workflows remain available.",deepEnabled:false},amount,evidence:[],history:[],closed:trade.status==="CLOSED",page,hasOlder:false,error:"Unable to load AI review history or configuration. Refresh after the review migrations/configuration are available."};}
}
export type TradeReviewPanelData=Awaited<ReturnType<typeof loadTradeReviewPanel>>;
