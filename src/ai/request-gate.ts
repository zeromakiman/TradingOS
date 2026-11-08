import type { AiProviderRequest,AiProviderResult } from "./provider-contract";
import { operationFor } from "./operations";
import { providerFor } from "./providers";
import { assertOperationExecutionAllowed } from "./provider-config";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ProviderError } from "./provider";
import { issueAiPermit } from "./permit";
import { acceptsResponseModel, operationPricing, reservationMicros } from "./pricing";
import { estimateRequest } from "./request-estimate";

export interface AiLedger {
 reserve(record: {id:string;userId:string;accountId:string;operationId:string;stage:string;hash:string;model:string;operation:string;provider:string;pricing:unknown;amount:number}):Promise<void>;
 dispatch(id:string,userId:string,hash:string):Promise<void>;
 recheck(id:string,userId:string,hash:string):Promise<void>;
 settle(id:string,userId:string,record:Record<string,unknown>):Promise<void>;
}
/**
 * Usage marker of a dispatched request that never reached the provider: no request of any kind (input count or
 * generation) was issued for it. 0018 Part 4: SQL accepts it only while no generation was committed.
 */
export const GENERATION_NOT_SENT=Object.freeze({generation:"NOT_SENT"});
/**
 * The only application entry to a paid provider. No automatic retries. Each deep pass reauthorizes.
 * Before anything is reserved, the whole request is estimated locally and refused when it is above the operation's
 * input limit, so an oversized request never reaches the provider and never holds budget.
 *
 * A reservation is released at zero cost only when no provider request of any kind was issued for it: a failed
 * reserve (including one that committed and lost its response), a failed dispatch (including one that committed and
 * lost its response) and an adapter failure before its first provider request (envelope, image, payload or contract
 * errors). The adapter reports every provider request through `beforeContact` before issuing it, and the input count
 * is one: no billed-cost contract for token counting is established (docs/AI_BUDGET_REVIEW.md), so every failure
 * after contact without usable usage (count unavailable, count above the limit, a refused recheck, a timeout, an
 * aborted or unreadable response) keeps the full reservation held as UNCERTAIN, as in V1. A response with usable
 * usage settles it. The paid generation request is sent only once `beforeGenerate` resolved; its recheck records the
 * generation commit (ai_request_generations), after which SQL refuses any release.
 */
export async function budgetedAiRequest(input: AiProviderRequest, owner:{userId:string;accountId:string;operationId:string;stage:string;operation:string}, ledger:AiLedger, transport?:typeof fetch) {
 // Own the request snapshot across async reservation/dispatch boundaries.
 input=structuredClone(input);
 if(process.env.AI_ENABLED!=="true")throw new Error("AI analysis is currently disabled");
 const operation=operationFor(owner.operation);
 assertOperationExecutionAllowed(operation.provider,input.apiKey);
 const adapter=providerFor(operation.provider),pricing=operationPricing(operation);
 if(input.config.model!==operation.model||input.config.reasoningEffort!==operation.reasoningEffort||input.config.imageDetail!==operation.imageDetail||input.config.timeoutMs!==operation.timeoutMs)throw new Error("Unreviewed AI model or effort");
 if(input.config.maxOutputTokens!==operation.maxOutputTokens)throw new Error("Unreviewed AI output limit");
 // Pre-flight: nothing is reserved, dispatched or sent for a request that cannot fit the reviewed input limit.
 if(estimateRequest(operation,input).tokens>operation.maxInputTokens)throw new ProviderError("INPUT_LIMIT_EXCEEDED");
 const amount=reservationMicros(pricing,operation), id=randomUUID();
 const hash=createHash("sha256").update(JSON.stringify({operation,config:input.config,context:input.context,images:input.images,prior:input.prior})).digest("hex");
 try {
  await ledger.reserve({id,...owner,hash,model:input.config.model,operation:operation.id,provider:operation.provider,pricing:{...pricing,operation},amount});
 } catch(error) {
  // A reserve call that lost its response may have committed. That reservation was never dispatched, so it is
  // released at once instead of staying held until the month ends. When nothing was reserved SQL refuses this
  // release ("Reservation not found"); either way the original failure is reported.
  try {await ledger.settle(id,owner.userId,{disposition:"CANCELLED",chargedMicros:0,errorCode:"NOT_DISPATCHED"});} catch {/* nothing to release */}
  throw error;
 }
 let dispatched=false;
 try {
  assertOperationExecutionAllowed(operation.provider,input.apiKey);
  await ledger.dispatch(id,owner.userId,hash);
  dispatched=true;
 } catch(error) {
  // The adapter never ran, so nothing reached the provider. A dispatch that lost its response may still have
  // committed: the NOT_SENT marker lets SQL release the reservation either way (0018 Part 4).
  await ledger.settle(id,owner.userId,{disposition:"CANCELLED",chargedMicros:0,usage:GENERATION_NOT_SENT,errorCode:"NOT_DISPATCHED"});
  throw error;
 }
 let result: AiProviderResult|undefined, failure:unknown, generationCommitted=false, providerContacted=false;
 try { result=await adapter.execute(input,transport,issueAiPermit(),operation,async()=>{assertOperationExecutionAllowed(operation.provider,input.apiKey);operationPricing(operation);await ledger.recheck(id,owner.userId,hash);generationCommitted=true;},()=>{providerContacted=true;}); } catch(error) {failure=error;}
 const usage=result?.usage??(failure instanceof ProviderError?failure.usage:null);
 const responseModel=result?.model??(failure instanceof ProviderError?failure.model:null);
 const responseId=result?.responseId??(failure instanceof ProviderError?failure.responseId:null);
 const errorCode=failure instanceof ProviderError?failure.code:failure?"PROVIDER_FAILURE":null;
 // Never reached the provider: no request was issued (count or generation), so there is no result, no committed
 // generation and no provider response (usage, id, model). Anything else is settled or held below.
 if(!providerContacted&&!result&&!generationCommitted&&usage==null&&responseId==null&&responseModel==null){
  try {
   await ledger.settle(id,owner.userId,{disposition:"CANCELLED",chargedMicros:0,usage:GENERATION_NOT_SENT,errorCode});
  } catch {
   // SQL refused the release (a generation commit exists) or it could not be saved: keep the full reservation held.
   await ledger.settle(id,owner.userId,{disposition:"UNCERTAIN",chargedMicros:amount,usage:null,responseModel:null,responseId:null,errorCode});
   throw new ProviderError("ACCOUNTING_UNCERTAIN");
  }
  throw failure??new ProviderError("NO_RESULT");
 }
 const record:Record<string,unknown>={disposition:"UNCERTAIN",chargedMicros:amount,usage,responseModel,responseId,errorCode};
 try {
  if(!acceptsResponseModel(pricing,responseModel))throw new Error("Unreviewed response model");
  const priced=adapter.accountUsage(usage,pricing);
  if(priced.inputTokens>operation.maxInputTokens||priced.outputTokens>operation.maxOutputTokens||priced.chargedMicros>amount)throw new Error("Provider exceeded operation bounds");
  Object.assign(record,priced,{disposition:"SETTLED"});
 } catch {record.errorCode=record.errorCode??"ACCOUNTING_UNCERTAIN";}
 if(dispatched)await ledger.settle(id,owner.userId,record); // Failure leaves the reservation held; never retry the provider.
 if(record.disposition==="UNCERTAIN")throw new ProviderError("ACCOUNTING_UNCERTAIN",usage,responseId,responseModel);
 if(failure)throw failure;
 if(!result)throw new ProviderError("NO_RESULT");
 return result;
}
