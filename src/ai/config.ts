import { operationFor } from "./operations";
export const EVALUATOR_VERSION="ICT_EVALUATOR_V2";
export const SCHEMA_VERSION="2.0";
export const GRADING_CONFIG={version:"PROCESS_1",weights:"Equal weights across six setup components; evidence clarity excluded",ratings:{STRONG:100,ADEQUATE:75,WEAK:40,INVALID:0},thresholds:{A:90,B:75,C:60,D:0},ruleViolationCap:39,unknown:"UNRATED"} as const;
export function modelConfig(env:Record<string,string|undefined>=process.env){
 const op=operationFor("SETUP_ANALYSIS");
 if(env.OPENAI_SETUP_MODEL&&env.OPENAI_SETUP_MODEL!==op.model)throw new Error("Model must match the reviewed operation registry");
 if(env.OPENAI_SETUP_REASONING&&env.OPENAI_SETUP_REASONING!==op.reasoningEffort)throw new Error("Reasoning must match the reviewed operation registry");
 return {model:op.model,reasoningEffort:op.reasoningEffort,timeoutMs:op.timeoutMs,maxOutputTokens:op.maxOutputTokens,deepEnabled:env.OPENAI_SETUP_DEEP_REVIEW!=="false",imageDetail:op.imageDetail};
}
