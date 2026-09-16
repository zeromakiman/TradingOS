import { z } from "zod";
import type { modelConfig } from "./config";
import { chartEvaluationSchema } from "./chart-contract";
import { SYSTEM_PROMPT } from "./analysis-prompt";
import { assertAiExecutionAllowed } from "./availability";
export class ProviderError extends Error {constructor(public code:string,public usage:unknown=null,public responseId:string|null=null,public model:string|null=null){super(code);}}
const responseSchema=z.object({id:z.string(),model:z.string(),status:z.string(),usage:z.unknown().optional(),output:z.array(z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()).optional()}).passthrough())}).passthrough();
export async function callResponses(input:{apiKey:string;config:ReturnType<typeof modelConfig>;context:unknown;images:{sourceId:string;role:string;dataUrl:string}[];prior:unknown[]},transport:typeof fetch=fetch){
 assertAiExecutionAllowed(input.apiKey);
 const content:Record<string,unknown>[]=[{type:"input_text",text:JSON.stringify({context:input.context,prior_evaluations:input.prior})}];
 for(const img of input.images)content.push({type:"input_text",text:`Chart source ${img.sourceId}; user-assigned timeframe ${img.role}.`},{type:"input_image",image_url:img.dataUrl,detail:input.config.imageDetail});
 let response:Response;
 try{response=await transport("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${input.apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:input.config.model,instructions:SYSTEM_PROMPT,input:[{role:"user",content}],store:false,reasoning:{effort:input.config.reasoningEffort},max_output_tokens:input.config.maxOutputTokens,text:{format:{type:"json_schema",name:"ict_setup_v2",strict:true,schema:chartEvaluationSchema}}}),signal:AbortSignal.timeout(input.config.timeoutMs)});}catch{throw new ProviderError("TIMEOUT_OR_NETWORK");}
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
