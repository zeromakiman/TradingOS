import {operationAllowedSources} from "@/ai/citation-sources";
import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import {ownedMonthlyAccount,loadMonthlyFacts,MonthlyScopeError} from "./monthly-review-source";
import {accountAiAvailability,serverAiLedger} from "./ai-budget";
import {trustedServer} from "./supabase/admin";
import {operationFor} from "@/ai/operations";
import {operationContract} from "@/ai/operation-contract";
import {providerKey} from "@/ai/provider-config";
import {budgetedAiRequest} from "@/ai/request-gate";
import {ProviderError} from "@/ai/provider";
import {validateMonthlyReview} from "@/ai/monthly-review-contract";
import {monthlyPeriod} from "@/ai/monthly-period";
export async function reviewMonth(accountId:string,month:string,requestId:string){
 z.uuid().parse(requestId);
 const period=monthlyPeriod(month),owner=await ownedMonthlyAccount(accountId),operation=operationFor("MONTHLY_REVIEW");
 const availability=await accountAiAvailability(owner.account.id,operation.id);
 if(availability.status!=="ENABLED")return {status:availability.status,message:availability.message};
 let facts:Awaited<ReturnType<typeof loadMonthlyFacts>>;
 try {facts=await loadMonthlyFacts(owner,period.month);}catch(error){if(error instanceof MonthlyScopeError)return {status:"SCOPE_LIMIT",message:error.message};throw error;}
 if(!facts.trades.length)return {status:"EMPTY",message:"No completed trades in this month. No AI request was made."};
 const admin=trustedServer(),start=await admin.rpc("start_monthly_ai_review",{p_id:requestId,p_user_id:owner.user.id,p_account_id:owner.account.id,p_month_start:period.startDate,p_facts:facts,p_hash:createHash("sha256").update(JSON.stringify(facts)).digest("hex"),p_operation:operation,p_contract:operationContract(operation,facts)});
 if(start.error)throw new Error("Could not start monthly review. Refresh the month and check history for a running attempt.");
 if(start.data!==true)return {status:"RECORDED",message:"This request was already recorded. No additional provider request was made."};
 let reservationId:string|null=null,raw:unknown=null,interpretation:ReturnType<typeof validateMonthlyReview>|null=null,errorCode:string|null=null;
 const authorize=async()=>{const {error}=await admin.rpc("authorize_monthly_ai_review",{p_id:requestId,p_user_id:owner.user.id});if(error)throw new ProviderError("MONTHLY_REVIEW_UNAVAILABLE");};
 try {
  const ledger=serverAiLedger();
  const result=await budgetedAiRequest({apiKey:providerKey(operation.provider),config:{model:operation.model,reasoningEffort:operation.reasoningEffort,timeoutMs:operation.timeoutMs,maxOutputTokens:operation.maxOutputTokens,imageDetail:operation.imageDetail,deepEnabled:false},context:facts,images:[],prior:[]},{userId:owner.user.id,accountId:owner.account.id,operationId:requestId,stage:"A",operation:operation.id},{...ledger,reserve:async record=>{await authorize();await ledger.reserve(record);reservationId=record.id;},dispatch:async(...args)=>{await authorize();await ledger.dispatch(...args);},recheck:async(...args)=>{await authorize();await ledger.recheck(...args);}});
  raw=result.output;interpretation=validateMonthlyReview(raw,operationAllowedSources("MONTHLY_REVIEW",facts));
 }catch(error){errorCode=error instanceof ProviderError?error.code:raw!==null?"INVALID_MONTHLY_OUTPUT":"MONTHLY_REVIEW_FAILED";}
 const finish=await admin.rpc("finish_monthly_ai_review",{p_id:requestId,p_user_id:owner.user.id,p_status:interpretation?"COMPLETED":"FAILED",p_interpretation:interpretation,p_error:errorCode,p_raw:raw,p_reservation_id:reservationId});
 if(finish.error)throw new Error("Monthly review could not finish saving. Check history before retrying; no automatic retry occurred.");
 return {status:interpretation?"COMPLETED":"FAILED",message:interpretation?"Monthly review saved. Trading records and deterministic calculations are unchanged.":"Monthly review failed. The attempt and protected accounting remain in history."};
}
