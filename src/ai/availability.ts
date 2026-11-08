import { operationFor } from "./operations";
import { providerKey } from "./provider-config";
import { modelConfig } from "./config";
/** ACCOUNTING_REVIEW: an earlier request of the account ended without a confirmed cost, so its reservation is held and AI is paused (docs/AI_ACCOUNTING_RESOLUTION.md). */
export type AiAvailability={status:"DISABLED"|"CONFIGURATION_ERROR"|"ENABLED"|"ACCOUNT_OFF"|"BUDGET_REACHED"|"ACCOUNTING_REVIEW";message:string;deepEnabled:boolean};
/** What a held reservation means, in plain words: what happened, what was charged and what resolves it. */
export const HELD_RESERVATION_MESSAGE="AI is paused for this account: an earlier AI request ended without a confirmed cost. The amount held for it stays in place, and nothing beyond that amount was charged. AI resumes once an accounting review confirms the cost or releases the hold. Other Trading OS workflows are unaffected.";
/** Fail closed: only the literal true enables AI. Invalid AI settings never crash normal pages. */
export function aiAvailability(env:Record<string,string|undefined>=process.env):AiAvailability{
 if(env.AI_ENABLED!=="true")return {status:"DISABLED",message:"AI analysis is currently disabled",deepEnabled:false};
 try{providerKey(operationFor("SETUP_ANALYSIS").provider,env);}catch(e){return {status:"CONFIGURATION_ERROR",message:e instanceof Error?e.message:"AI provider is unavailable",deepEnabled:false};}
 try{return {status:"ENABLED",message:"AI analysis is available",deepEnabled:modelConfig(env).deepEnabled};}
 catch{return {status:"CONFIGURATION_ERROR",message:"AI model configuration is invalid. Other application features remain available.",deepEnabled:false};}
}
export function assertAiExecutionAllowed(apiKey?:string){
 const state=aiAvailability(apiKey===undefined?process.env:{...process.env,OPENAI_API_KEY:apiKey});
 if(state.status!=="ENABLED")throw new Error(state.message);
}
