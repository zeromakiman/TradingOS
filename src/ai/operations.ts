/** Reviewed operation envelopes, not model context capacities. No client overrides. */
export interface AiOperation {
 id: string; version: string; provider: string; model: string; reasoningEffort: string; contract:"SETUP_V2"|"REVIEW_TRADE_V1"|"CHALLENGE_BIAS_V1"|"ANALYZE_SETUP_V1"|"WEEKLY_REVIEW_V1"|"RECENT_TRADES_V1";
 maxInputTokens: number; maxOutputTokens: number; maxImages: number; tools: readonly string[];
 imageDetail: "high"; pricingProfile: string; safetyMultiplier: string; timeoutMs: number;
}
const base = {version:"BOUNDED_SETUP_V1",provider:"openai",model:"gpt-6-astra",reasoningEffort:"high",contract:"SETUP_V2",
 maxInputTokens:32000,maxOutputTokens:8000,maxImages:8,tools:Object.freeze([]),imageDetail:"high",
 pricingProfile:"ASTRA_EUR_2026_09_23",safetyMultiplier:"1.10",timeoutMs:180000} as const;
export const AI_OPERATIONS: Readonly<Record<string,Readonly<AiOperation>>> = Object.freeze({
 SETUP_ANALYSIS:Object.freeze({...base,id:"SETUP_ANALYSIS"}),
 SETUP_CHALLENGE:Object.freeze({...base,id:"SETUP_CHALLENGE"}),
 SETUP_RECONCILE:Object.freeze({...base,id:"SETUP_RECONCILE",maxInputTokens:48000}),
 REVIEW_TRADE:Object.freeze({...base,id:"REVIEW_TRADE",version:"REVIEW_TRADE_V1",contract:"REVIEW_TRADE_V1",reasoningEffort:"medium",maxInputTokens:24000,maxOutputTokens:6000,maxImages:4}),
 CHALLENGE_BIAS:Object.freeze({...base,id:"CHALLENGE_BIAS",version:"CHALLENGE_BIAS_V1",contract:"CHALLENGE_BIAS_V1",reasoningEffort:"medium",maxInputTokens:16000,maxOutputTokens:4000,maxImages:3}),
 ANALYZE_SETUP:Object.freeze({...base,id:"ANALYZE_SETUP",version:"ANALYZE_SETUP_V1",contract:"ANALYZE_SETUP_V1",reasoningEffort:"medium",maxInputTokens:16000,maxOutputTokens:5000,maxImages:3}),
 WEEKLY_REVIEW:Object.freeze({...base,id:"WEEKLY_REVIEW",version:"WEEKLY_REVIEW_V1",contract:"WEEKLY_REVIEW_V1",reasoningEffort:"medium",maxInputTokens:24000,maxOutputTokens:6000,maxImages:0}),
 RECENT_TRADES_ANALYSIS:Object.freeze({...base,id:"RECENT_TRADES_ANALYSIS",version:"RECENT_TRADES_V1",contract:"RECENT_TRADES_V1",reasoningEffort:"medium",maxInputTokens:32000,maxOutputTokens:6000,maxImages:0}),
});
export function operationFor(id:string):Readonly<AiOperation> {
 if(!Object.hasOwn(AI_OPERATIONS,id))throw new Error("Unknown AI operation");
 return AI_OPERATIONS[id];
}
export function setupOperation(stage:string) {
 if(stage==="A")return operationFor("SETUP_ANALYSIS");
 if(stage==="B")return operationFor("SETUP_CHALLENGE");
 if(stage==="RECONCILER")return operationFor("SETUP_RECONCILE");
 throw new Error("Unknown AI operation stage");
}
