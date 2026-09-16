import { modelConfig } from "./config";
export type AiAvailability={status:"DISABLED"|"CONFIGURATION_ERROR"|"ENABLED";message:string;deepEnabled:boolean};
/** Fail closed: only the literal true enables AI. Invalid AI settings never crash normal pages. */
export function aiAvailability(env:Record<string,string|undefined>=process.env):AiAvailability{
 if(env.AI_ENABLED!=="true")return {status:"DISABLED",message:"AI analysis is currently disabled",deepEnabled:false};
 if(!env.OPENAI_API_KEY?.trim())return {status:"CONFIGURATION_ERROR",message:"AI is enabled but its API key is missing. Other application features remain available.",deepEnabled:false};
 try{return {status:"ENABLED",message:"AI analysis is available",deepEnabled:modelConfig(env).deepEnabled};}
 catch{return {status:"CONFIGURATION_ERROR",message:"AI model configuration is invalid. Other application features remain available.",deepEnabled:false};}
}
export function assertAiExecutionAllowed(apiKey?:string){
 const state=aiAvailability(apiKey===undefined?process.env:{...process.env,OPENAI_API_KEY:apiKey});
 if(state.status!=="ENABLED")throw new Error(state.message);
}
