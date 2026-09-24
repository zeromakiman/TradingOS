import Decimal from "decimal.js";
import { z } from "zod";
import { operationFor, type AiOperation } from "./operations";

// Reviewed against https://developers.openai.com/api/docs/models/gpt-6-astra on 2026-09-23.
// No inferred prices for unreviewed snapshots. Re-review expiry before live activation.
export const AI_PRICING = {
 version: "ASTRA_EUR_2026_09_23", provider: "openai", model: "gpt-6-astra",
 source: "https://developers.openai.com/api/docs/models/gpt-6-astra",
 validUntil: "2026-10-22T00:00:00Z", contextTokens: 1050000, maxOutputTokens: 14000,
 longContextThreshold: 272000, longInputMultiplier:"2",longOutputMultiplier:"1.5", inputUsdPerMillion: "10", cachedUsdPerMillion: "1",
 cacheWriteUsdPerMillion: "12.5", outputUsdPerMillion: "50",
 // Conservative application conversion policy, NOT a live exchange-rate quote or provider invoice.
 usdCostToEurBudgetMultiplier: "1.20", serviceTier: "default",
} as const;
export interface Pricing {
 version:string;provider:string;model:string;source:string;validUntil:string;contextTokens:number;maxOutputTokens:number;
 longContextThreshold:number;longInputMultiplier:string;longOutputMultiplier:string;inputUsdPerMillion:string;cachedUsdPerMillion:string;cacheWriteUsdPerMillion:string;outputUsdPerMillion:string;
 usdCostToEurBudgetMultiplier:string;serviceTier:string;
}
export const PRICING_PROFILES:Readonly<Record<string,Pricing>>=Object.freeze({[AI_PRICING.version]:Object.freeze(AI_PRICING)});
export function operationPricing(operation:AiOperation,now=new Date()):Pricing {
 const p=PRICING_PROFILES[operation.pricingProfile];
 if(!p||p.provider!==operation.provider||p.model!==operation.model||now.getTime()>=Date.parse(p.validUntil))throw new Error("AI pricing requires review before requests can run.");
 if(operation.maxInputTokens>p.contextTokens||operation.maxOutputTokens>p.maxOutputTokens)throw new Error("Operation exceeds pricing bounds");
 return p;
}
export function pricingFor(model: string, now = new Date()): Pricing {
 const pricing=Object.values(PRICING_PROFILES).find(p=>p.model===model);
 if (!pricing || now.getTime() >= Date.parse(pricing.validUntil)) throw new Error("AI pricing requires review before requests can run.");
 return pricing;
}
export function reservationMicros(pricing:Pricing=AI_PRICING,operation:AiOperation=operationFor("SETUP_ANALYSIS")) {
 const long=operation.maxInputTokens>pricing.longContextThreshold;
 return new Decimal(operation.maxInputTokens).mul(Decimal.max(pricing.inputUsdPerMillion,pricing.cachedUsdPerMillion,pricing.cacheWriteUsdPerMillion)).mul(long?pricing.longInputMultiplier:1)
 .add(new Decimal(operation.maxOutputTokens).mul(pricing.outputUsdPerMillion).mul(long?pricing.longOutputMultiplier:1))
 .mul(pricing.usdCostToEurBudgetMultiplier).mul(operation.safetyMultiplier).ceil().toNumber();
}
const token = z.number().int().nonnegative().max(2000000);
const usageSchema = z.object({ input_tokens: token, output_tokens: token,
 input_tokens_details: z.object({ cached_tokens: token.default(0), cache_write_tokens: token.optional() }).passthrough().optional(),
 output_tokens_details: z.object({ reasoning_tokens: token.default(0) }).passthrough().optional(),
}).passthrough();
export function priceUsage(raw: unknown, pricing: Pricing = AI_PRICING) {
 const u = usageSchema.parse(raw), cached = u.input_tokens_details?.cached_tokens ?? 0;
 const writes = u.input_tokens_details?.cache_write_tokens;
 const reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
 if (cached + (writes ?? 0) > u.input_tokens || reasoning > u.output_tokens) throw new Error("Inconsistent provider usage");
 if (u.input_tokens > pricing.contextTokens || u.output_tokens > pricing.maxOutputTokens) throw new Error("Provider usage exceeds reviewed bounds");
 const long = u.input_tokens > pricing.longContextThreshold;
 // Older responses without cache-write detail receive the higher conservative input rate.
 const uncached = u.input_tokens - cached - (writes ?? 0);
 const input = new Decimal(uncached).mul(writes === undefined ? pricing.cacheWriteUsdPerMillion : pricing.inputUsdPerMillion)
  .add(new Decimal(cached).mul(pricing.cachedUsdPerMillion)).add(new Decimal(writes ?? 0).mul(pricing.cacheWriteUsdPerMillion)).mul(long?pricing.longInputMultiplier:1);
 const output = new Decimal(u.output_tokens).mul(pricing.outputUsdPerMillion).mul(long?pricing.longOutputMultiplier:1);
 return { chargedMicros: input.add(output).mul(pricing.usdCostToEurBudgetMultiplier).ceil().toNumber(), inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedTokens: cached, cacheWriteTokens: writes ?? null, reasoningTokens: reasoning };
}
