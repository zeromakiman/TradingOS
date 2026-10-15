import {operationAllowedSources} from "@/ai/citation-sources";
import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import {ownedWeeklyAccount,loadWeeklyFacts,WeeklyScopeError} from "./weekly-review-source";
import {accountAiAvailability,serverAiLedger} from "./ai-budget";
import {trustedServer} from "./supabase/admin";
import {operationFor} from "@/ai/operations";
import {operationContract} from "@/ai/operation-contract";
import {providerKey} from "@/ai/provider-config";
import {budgetedAiRequest} from "@/ai/request-gate";
import {ProviderError} from "@/ai/provider";
import {validateWeeklyReview} from "@/ai/weekly-review-contract";
import {weeklyPeriod} from "@/ai/weekly-period";
export async function reviewWeek(accountId:string,day:string,requestId:string){
 z.uuid().parse(requestId);
 const period=weeklyPeriod(day),owner=await ownedWeeklyAccount(accountId),operation=operationFor("WEEKLY_REVIEW");
 const availability=await accountAiAvailability(owner.account.id,operation.id);
 if(availability.status!=="ENABLED")return {status:availability.status,message:availability.message};
 let facts:Awaited<ReturnType<typeof loadWeeklyFacts>>;
 try {facts=await loadWeeklyFacts(owner,period.startDate);}catch(error){if(error instanceof WeeklyScopeError)return {status:"SCOPE_LIMIT",message:error.message};throw error;}
 if(!facts.trades.length)return {status:"EMPTY",message:"No completed trades in this week. No AI request was made."};
 const admin=trustedServer(),start=await admin.rpc("start_weekly_ai_review",{p_id:requestId,p_user_id:owner.user.id,p_account_id:owner.account.id,p_week_start:period.startDate,p_facts:facts,p_hash:createHash("sha256").update(JSON.stringify(facts)).digest("hex"),p_operation:operation,p_contract:operationContract(operation,facts)});
 if(start.error)throw new Error("Could not start weekly review. Check history for a running attempt.");
 if(start.data!==true)return {status:"RECORDED",message:"This request was already recorded. No additional provider request was made."};
 let reservationId:string|null=null,raw:unknown=null,interpretation:ReturnType<typeof validateWeeklyReview>|null=null,errorCode:string|null=null;
 const authorize=async()=>{const {error}=await admin.rpc("authorize_weekly_ai_review",{p_id:requestId,p_user_id:owner.user.id});if(error)throw new ProviderError("WEEKLY_REVIEW_UNAVAILABLE");};
 try {
  const ledger=serverAiLedger();
  const result=await budgetedAiRequest({apiKey:providerKey(operation.provider),config:{model:operation.model,reasoningEffort:operation.reasoningEffort,timeoutMs:operation.timeoutMs,maxOutputTokens:operation.maxOutputTokens,imageDetail:operation.imageDetail,deepEnabled:false},context:facts,images:[],prior:[]},{userId:owner.user.id,accountId:owner.account.id,operationId:requestId,stage:"A",operation:operation.id},{...ledger,reserve:async record=>{await authorize();await ledger.reserve(record);reservationId=record.id;},dispatch:async(...args)=>{await authorize();await ledger.dispatch(...args);},recheck:async(...args)=>{await authorize();await ledger.recheck(...args);}});
  raw=result.output;interpretation=validateWeeklyReview(raw,operationAllowedSources("WEEKLY_REVIEW",facts));
 }catch(error){errorCode=error instanceof ProviderError?error.code:raw!==null?"INVALID_WEEKLY_OUTPUT":"WEEKLY_REVIEW_FAILED";}
 const finish=await admin.rpc("finish_weekly_ai_review",{p_id:requestId,p_user_id:owner.user.id,p_status:interpretation?"COMPLETED":"FAILED",p_interpretation:interpretation,p_error:errorCode,p_raw:raw,p_reservation_id:reservationId});
 if(finish.error)throw new Error("Weekly review could not finish saving. Check history before retrying; no automatic retry occurred.");
 return {status:interpretation?"COMPLETED":"FAILED",message:interpretation?"Weekly review saved. Trading records and deterministic calculations are unchanged.":"Weekly review failed. The attempt and protected accounting remain in history."};
}
