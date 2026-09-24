import { operationFor } from "./operations";
import { providerKey } from "./provider-config";
import { modelConfig } from "./config";
export type AiAvailability={status:"DISABLED"|"CONFIGURATION_ERROR"|"ENABLED"|"ACCOUNT_OFF"|"BUDGET_REACHED";message:string;deepEnabled:boolean};
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
