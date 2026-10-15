import { assertOperationExecutionAllowed } from "./provider-config";
import type { AiOperation } from "./operations";
import { z } from "zod";
import type { AiProviderRequest, AiProviderResult } from "./provider-contract";
import { operationContract } from "./operation-contract";
import { assertAiExecutionAllowed } from "./availability";
import { consumeAiPermit } from "./permit";
export class ProviderError extends Error {constructor(public code:string,public usage:unknown=null,public responseId:string|null=null,public model:string|null=null){super(code);}}
const responseSchema=z.object({id:z.string(),model:z.string(),status:z.string(),usage:z.unknown().optional(),output:z.array(z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()).optional()}).passthrough())}).passthrough();
export async function callResponses(input:AiProviderRequest,transport:typeof fetch=fetch,permit?:object,operation?:AiOperation,beforeGenerate?:()=>Promise<void>):Promise<AiProviderResult>{
 if(operation)assertOperationExecutionAllowed(operation.provider,input.apiKey);else assertAiExecutionAllowed(input.apiKey);
 // Existing adapter tests inject an in-memory transport; production has no ungated network path.
 if(process.env.NODE_ENV!=="test"||transport===fetch){consumeAiPermit(permit);if(!operation)throw new Error("A bounded operation is required");}
 const content:Record<string,unknown>[]=[{type:"input_text",text:JSON.stringify({context:input.context,prior_evaluations:input.prior})}];
 for(const img of input.images)content.push({type:"input_text",text:`Chart source ${img.sourceId}; user-assigned timeframe ${img.role}.`},{type:"input_image",image_url:img.dataUrl,detail:input.config.imageDetail});
 const contract=operationContract(operation,input.context);
 const payload={model:input.config.model,instructions:contract.instructions,input:[{role:"user",content}],store:false,service_tier:"default",truncation:"disabled",reasoning:{effort:input.config.reasoningEffort},max_output_tokens:input.config.maxOutputTokens,text:{format:{type:"json_schema",name:contract.name,strict:true,schema:contract.schema}}};
 const wire=JSON.stringify(payload);
 const countWire=JSON.stringify({model:payload.model,instructions:payload.instructions,input:payload.input,reasoning:payload.reasoning,text:payload.text,truncation:payload.truncation});
 const send=(url:string,body=wire)=>transport(url,{method:"POST",headers:{Authorization:`Bearer ${input.apiKey}`,"Content-Type":"application/json"},body,signal:AbortSignal.timeout(input.config.timeoutMs)});
 if(operation){
  if(operation.provider!=="openai"||operation.model!==input.config.model||operation.maxOutputTokens!==input.config.maxOutputTokens||operation.reasoningEffort!==input.config.reasoningEffort||operation.tools.length||input.images.length>operation.maxImages)throw new ProviderError("INVALID_OPERATION_ENVELOPE");
  // No remote image URLs, mutable files, conversations or provider-side tools are accepted.
  if(input.images.some(i=>!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.dataUrl)))throw new ProviderError("INVALID_OPERATION_IMAGE");
  if(Buffer.byteLength(wire)>64*1024*1024)throw new ProviderError("OPERATION_PAYLOAD_TOO_LARGE");
  let count:number;
  try{const response=await send("https://api.openai.com/v1/responses/input_tokens",countWire);if(!response.ok)throw new Error();count=z.object({input_tokens:z.number().int().nonnegative()}).parse(await response.json()).input_tokens;}catch{throw new ProviderError("INPUT_COUNT_UNAVAILABLE");}
  if(count>operation.maxInputTokens)throw new ProviderError("INPUT_LIMIT_EXCEEDED");
  await beforeGenerate?.();
  assertAiExecutionAllowed(input.apiKey);
 }
 let response:Response;
 try{response=await send("https://api.openai.com/v1/responses");}catch{throw new ProviderError("TIMEOUT_OR_NETWORK");}
 if(!response.ok)throw new ProviderError(response.status===429?"RATE_LIMIT":response.status===401?"OPENAI_AUTH":response.status===403||response.status===404?"MODEL_ACCESS":"MODEL_ERROR");
 let raw:unknown;try{raw=await response.json();}catch{throw new ProviderError("INVALID_RESPONSE");}
 const parsed=responseSchema.safeParse(raw);if(!parsed.success)throw new ProviderError("INVALID_RESPONSE");
 const body=parsed.data, metadata=[body.usage??null,body.id,body.model] as const;
 if(body.output.some(x=>x.content?.some(c=>c.type==="refusal")))throw new ProviderError("REFUSED",...metadata);
 if(body.status!=="completed")throw new ProviderError("INCOMPLETE",...metadata);
 const texts=body.output.flatMap(x=>x.content??[]).filter(c=>c.type==="output_text");
 if(texts.length!==1||!texts[0].text)throw new ProviderError("INVALID_RESPONSE",...metadata);
 try{return {output:JSON.parse(texts[0].text) as unknown,responseId:body.id,model:body.model,usage:body.usage??null};}catch{throw new ProviderError("INVALID_JSON",...metadata);}
}
