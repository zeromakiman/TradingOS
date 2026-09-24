import "server-only";
import {createHash} from "node:crypto";
import {z} from "zod";
import {ownedRecentAccount,loadRecentFacts,RecentScopeError} from "./recent-trades-source";
import {accountAiAvailability,serverAiLedger} from "./ai-budget";
import {trustedServer} from "./supabase/admin";
import {operationFor} from "@/ai/operations";
import {operationContract} from "@/ai/operation-contract";
import {providerKey} from "@/ai/provider-config";
import {budgetedAiRequest} from "@/ai/request-gate";
import {ProviderError} from "@/ai/provider";
import {validateRecentTrades} from "@/ai/recent-trades-contract";
import {recentSample} from "@/ai/recent-trades-context";
export async function analyzeRecentTrades(accountId:string,sample:unknown,requestId:string){
 z.uuid().parse(requestId);
 const requested=recentSample(sample),owner=await ownedRecentAccount(accountId),operation=operationFor("RECENT_TRADES_ANALYSIS");
 const availability=await accountAiAvailability(owner.account.id,operation.id);
 if(availability.status!=="ENABLED")return {status:availability.status,message:availability.message};
 let loaded:Awaited<ReturnType<typeof loadRecentFacts>>;
 try {loaded=await loadRecentFacts(owner,requested);}catch(error){if(error instanceof RecentScopeError)return {status:"SCOPE_LIMIT",message:error.message};throw error;}
 const {facts}=loaded;
 if(!facts.trades.length)return {status:"EMPTY",message:"No completed trades in this sample. No AI request was made."};
 const admin=trustedServer(),start=await admin.rpc("start_recent_ai_analysis",{p_id:requestId,p_user_id:owner.user.id,p_account_id:owner.account.id,p_requested:requested,p_trade_ids:facts.sample.tradeIds,p_captured_at:facts.capturedAt,p_facts:facts,p_hash:createHash("sha256").update(JSON.stringify(facts)).digest("hex"),p_operation:operation,p_contract:operationContract(operation)});
 if(start.error)throw new Error("Could not start recent-trades analysis. Check history for a running attempt.");
 if(start.data!==true)return {status:"RECORDED",message:"This request was already recorded. No additional provider request was made."};
 let reservationId:string|null=null,raw:unknown=null,interpretation:ReturnType<typeof validateRecentTrades>|null=null,errorCode:string|null=null;
 const authorize=async()=>{const {error}=await admin.rpc("authorize_recent_ai_analysis",{p_id:requestId,p_user_id:owner.user.id});if(error)throw new ProviderError("RECENT_TRADES_ANALYSIS_UNAVAILABLE");};
 try {
  const ledger=serverAiLedger();
  const result=await budgetedAiRequest({apiKey:providerKey(operation.provider),config:{model:operation.model,reasoningEffort:operation.reasoningEffort,timeoutMs:operation.timeoutMs,maxOutputTokens:operation.maxOutputTokens,imageDetail:operation.imageDetail,deepEnabled:false},context:facts,images:[],prior:[]},{userId:owner.user.id,accountId:owner.account.id,operationId:requestId,stage:"A",operation:operation.id},{...ledger,reserve:async record=>{await authorize();await ledger.reserve(record);reservationId=record.id;},dispatch:async(...args)=>{await authorize();await ledger.dispatch(...args);},recheck:async(...args)=>{await authorize();await ledger.recheck(...args);}});
  raw=result.output;interpretation=validateRecentTrades(raw,facts.sourceRefs);
 }catch(error){errorCode=error instanceof ProviderError?error.code:raw!==null?"INVALID_RECENT_OUTPUT":"RECENT_TRADES_ANALYSIS_FAILED";}
 const finish=await admin.rpc("finish_recent_ai_analysis",{p_id:requestId,p_user_id:owner.user.id,p_status:interpretation?"COMPLETED":"FAILED",p_interpretation:interpretation,p_error:errorCode,p_raw:raw,p_reservation_id:reservationId});
 if(finish.error)throw new Error("Recent-trades analysis could not finish saving. Check history before retrying; no automatic retry occurred.");
 return {status:interpretation?"COMPLETED":"FAILED",message:interpretation?"Recent-trades analysis saved. Trading records and deterministic calculations are unchanged.":"Recent-trades analysis failed. The attempt and protected accounting remain in history."};
}
