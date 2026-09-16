export const EVALUATOR_VERSION="ICT_EVALUATOR_V2";
export const SCHEMA_VERSION="2.0";
export const GRADING_CONFIG={version:"PROCESS_1",weights:"Equal weights across six setup components; evidence clarity excluded",ratings:{STRONG:100,ADEQUATE:75,WEAK:40,INVALID:0},thresholds:{A:90,B:75,C:60,D:0},ruleViolationCap:39,unknown:"UNRATED"} as const;
export function modelConfig(env:Record<string,string|undefined>=process.env){
 const model=env.OPENAI_SETUP_MODEL||"gpt-6-astra";
 if(!/^gpt-6-astra(?:-[a-zA-Z0-9.-]+)?$/.test(model))throw new Error("Configure a GPT-6 Astra model or snapshot");
 const effort=env.OPENAI_SETUP_REASONING||"high";
 if(!["low","medium","high","xhigh","max"].includes(effort))throw new Error("Unsupported Astra reasoning effort");
 return {model,reasoningEffort:effort,timeoutMs:180000,maxOutputTokens:14000,deepEnabled:env.OPENAI_SETUP_DEEP_REVIEW!=="false",imageDetail:"high" as const};
}
