import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ownedReviewTrade,reviewEvidence } from "./trade-review-data";
import { accountAiAvailability,serverAiLedger } from "./ai-budget";
import { trustedServer } from "./supabase/admin";
import { SCREENSHOT_BUCKET } from "./screenshots";
import { riskRow } from "./data";
import { operationFor } from "@/ai/operations";
import { operationContract } from "@/ai/operation-contract";
import { providerKey } from "@/ai/provider-config";
import { budgetedAiRequest } from "@/ai/request-gate";
import { ProviderError } from "@/ai/provider";
import { tradeReviewContext } from "@/ai/trade-review-context";
import { validateTradeReview } from "@/ai/trade-review-contract";
const eventSchema=z.object({id:z.uuid(),event_type:z.string(),payload:z.record(z.string(),z.unknown()),occurred_at:z.string(),recorded_at:z.string()});
export async function reviewTrade(planId:string,requestId:string,selectedIds:string[]) {
 z.uuid().parse(requestId);z.array(z.uuid()).max(4).parse(selectedIds);
 if(new Set(selectedIds).size!==selectedIds.length)throw new Error("Duplicate evidence selection");
 const {db,user,plan,trade}=await ownedReviewTrade(planId);
 if(trade.status!=="CLOSED")return {status:"NOT_CLOSED",message:"Close the trade before requesting a post-trade review."};
 const availability=await accountAiAvailability(plan.account_id,"REVIEW_TRADE");
 if(availability.status!=="ENABLED")return {status:availability.status,message:availability.message};
 const operation=operationFor("REVIEW_TRADE"),contract=operationContract(operation);
 const eligible=await reviewEvidence(db,plan.id),selected=selectedIds.map(id=>eligible.find(x=>x.id===id));
 if(selected.some(x=>!x))throw new Error("Selected evidence is not available for this trade");
 const evidence=selected.filter((x):x is NonNullable<typeof x>=>!!x);
 const [strategy,risk,events]=await Promise.all([
  db.from("strategy_versions").select("id,version,rules,written_rules").eq("id",plan.strategy_version_id).eq("account_id",plan.account_id).single(),
  db.from("risk_plan_versions").select("id,version,effective_day,max_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text").eq("id",plan.risk_plan_version_id).eq("account_id",plan.account_id).single(),
  db.from("trade_events").select("id,event_type,payload,occurred_at,recorded_at").eq("plan_id",plan.id).order("sequence").limit(201),
 ]);
 if(strategy.error||risk.error||events.error)throw new Error("Trade context unavailable");
 const history=z.array(eventSchema).parse(events.data);
 if(history.length>200)throw new Error("This trade exceeds the bounded review event limit");
 const facts=tradeReviewContext(plan,trade,z.object({id:z.uuid(),version:z.string(),rules:z.record(z.string(),z.unknown()),written_rules:z.string()}).parse(strategy.data),riskRow.parse(risk.data),history,evidence);
 if(Buffer.byteLength(JSON.stringify(facts))>128000)throw new Error("This trade exceeds the bounded review context limit");
 const admin=trustedServer();
 const start=await admin.rpc("start_trade_ai_review",{p_id:requestId,p_user_id:user.id,p_plan_id:plan.id,p_facts:facts,p_hash:createHash("sha256").update(JSON.stringify(facts)).digest("hex"),p_operation:operation,p_contract:contract});
 if(start.error)throw new Error("Unable to start review. Check for an existing running review.");
 if(start.data!==true)return {status:"RECORDED",message:"This request was already recorded. No additional provider request was made."};
 let reservationId:string|null=null,raw:unknown=null,interpretation:ReturnType<typeof validateTradeReview>|null=null,errorCode:string|null=null;
 try {
  const images=[];
  for(const image of evidence){
   const {data,error}=await db.storage.from(SCREENSHOT_BUCKET).download(image.storage_path);
   if(error||!data)throw new ProviderError("SCREENSHOT_UNAVAILABLE");
   const bytes=Buffer.from(await data.arrayBuffer());
   if(bytes.length!==image.byte_size||createHash("sha256").update(bytes).digest("hex")!==image.sha256)throw new ProviderError("SCREENSHOT_CHANGED");
   images.push({sourceId:`evidence:${image.id}`,role:image.role,dataUrl:`data:${image.mime_type};base64,${bytes.toString("base64")}`});
  }
  const ledger=serverAiLedger();
  const result=await budgetedAiRequest({apiKey:providerKey(operation.provider),config:{model:operation.model,reasoningEffort:operation.reasoningEffort,timeoutMs:operation.timeoutMs,maxOutputTokens:operation.maxOutputTokens,imageDetail:operation.imageDetail,deepEnabled:false},context:facts,images,prior:[]},{userId:user.id,accountId:plan.account_id,operationId:requestId,stage:"A",operation:operation.id},{...ledger,reserve:async record=>{await ledger.reserve(record);reservationId=record.id;}});
  raw=result.output;interpretation=validateTradeReview(raw,facts.sourceRefs);
 } catch(error) {errorCode=error instanceof ProviderError?error.code:error instanceof z.ZodError?"INVALID_REVIEW_OUTPUT":"REVIEW_FAILED";}
 const finish=await admin.rpc("finish_trade_ai_review",{p_id:requestId,p_user_id:user.id,p_status:interpretation?"COMPLETED":"FAILED",p_interpretation:interpretation,p_error:errorCode,p_raw:raw,p_reservation_id:reservationId});
 if(finish.error)throw new Error("Review could not finish saving. Refresh history before requesting another review; no automatic retry was made.");
 return {status:interpretation?"COMPLETED":"FAILED",message:interpretation?"Trade review saved. Original records are unchanged.":"The review failed and the attempt was preserved in history. Check its accounting details before requesting another review."};
}
