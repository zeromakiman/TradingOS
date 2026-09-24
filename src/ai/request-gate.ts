import type { AiProviderRequest,AiProviderResult } from "./provider-contract";
import { operationFor } from "./operations";
import { providerFor } from "./providers";
import { assertOperationExecutionAllowed } from "./provider-config";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ProviderError } from "./provider";
import { issueAiPermit } from "./permit";
import { operationPricing, reservationMicros } from "./pricing";

export interface AiLedger {
 reserve(record: {id:string;userId:string;accountId:string;operationId:string;stage:string;hash:string;model:string;operation:string;provider:string;pricing:unknown;amount:number}):Promise<void>;
 dispatch(id:string,userId:string,hash:string):Promise<void>;
 recheck(id:string,userId:string,hash:string):Promise<void>;
 settle(id:string,userId:string,record:Record<string,unknown>):Promise<void>;
}
/** The only application entry to a paid provider. No automatic retries. Each deep pass reauthorizes. */
export async function budgetedAiRequest(input: AiProviderRequest, owner:{userId:string;accountId:string;operationId:string;stage:string;operation:string}, ledger:AiLedger, transport?:typeof fetch) {
 // Own the request snapshot across async reservation/dispatch boundaries.
 input=structuredClone(input);
 if(process.env.AI_ENABLED!=="true")throw new Error("AI analysis is currently disabled");
 const operation=operationFor(owner.operation);
 assertOperationExecutionAllowed(operation.provider,input.apiKey);
 const adapter=providerFor(operation.provider),pricing=operationPricing(operation);
 if(input.config.model!==operation.model||input.config.reasoningEffort!==operation.reasoningEffort||input.config.imageDetail!==operation.imageDetail||input.config.timeoutMs!==operation.timeoutMs)throw new Error("Unreviewed AI model or effort");
 if(input.config.maxOutputTokens!==operation.maxOutputTokens)throw new Error("Unreviewed AI output limit");
 const amount=reservationMicros(pricing,operation), id=randomUUID();
 const hash=createHash("sha256").update(JSON.stringify({operation,config:input.config,context:input.context,images:input.images,prior:input.prior})).digest("hex");
 await ledger.reserve({id,...owner,hash,model:input.config.model,operation:operation.id,provider:operation.provider,pricing:{...pricing,operation},amount});
 let dispatched=false;
 try {
  assertOperationExecutionAllowed(operation.provider,input.apiKey);
  await ledger.dispatch(id,owner.userId,hash);
  dispatched=true;
 } catch(error) {
  // A dispatch timeout may have committed. SQL refuses this refund if it did.
  await ledger.settle(id,owner.userId,{disposition:"CANCELLED",chargedMicros:0,errorCode:"NOT_DISPATCHED"});
  throw error;
 }
 let result: AiProviderResult|undefined, failure:unknown;
 try { result=await adapter.execute(input,transport,issueAiPermit(),operation,async()=>{assertOperationExecutionAllowed(operation.provider,input.apiKey);operationPricing(operation);await ledger.recheck(id,owner.userId,hash);}); } catch(error) {failure=error;}
 const usage=result?.usage??(failure instanceof ProviderError?failure.usage:null);
 const responseModel=result?.model??(failure instanceof ProviderError?failure.model:null);
 const record:Record<string,unknown>={disposition:"UNCERTAIN",chargedMicros:amount,usage,responseModel,responseId:result?.responseId??(failure instanceof ProviderError?failure.responseId:null),errorCode:failure instanceof ProviderError?failure.code:failure?"PROVIDER_FAILURE":null};
 try {
  if(responseModel!==pricing.model)throw new Error("Unreviewed response model");
  const priced=adapter.accountUsage(usage,pricing);
  if(priced.inputTokens>operation.maxInputTokens||priced.outputTokens>operation.maxOutputTokens||priced.chargedMicros>amount)throw new Error("Provider exceeded operation bounds");
  Object.assign(record,priced,{disposition:"SETTLED"});
 } catch {record.errorCode=record.errorCode??"ACCOUNTING_UNCERTAIN";}
 if(dispatched)await ledger.settle(id,owner.userId,record); // Failure leaves the reservation held; never retry the provider.
 if(record.disposition==="UNCERTAIN")throw new ProviderError("ACCOUNTING_UNCERTAIN",usage,result?.responseId??null,responseModel);
 if(failure)throw failure;
 if(!result)throw new ProviderError("NO_RESULT");
 return result;
}
