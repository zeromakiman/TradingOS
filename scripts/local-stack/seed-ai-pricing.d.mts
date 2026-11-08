// Types of seed-ai-pricing.mjs (local seeding tooling only).
import type { AiOperation } from "../../src/ai/operations";
import type { Pricing } from "../../src/ai/pricing";

export declare const SEEDED_AI_OPERATIONS: readonly string[];

/** The application's own src/ai/operations.ts and src/ai/pricing.ts modules (or the parts the seed uses). */
export interface SeedAiPricingApp {
  operations: { operationFor(id: string): AiOperation };
  pricing: { PRICING_PROFILES: Readonly<Record<string, Pricing>>; operationPricing(operation: AiOperation, now?: Date): Pricing };
}

export interface SeedAiPricing {
  /** One note per pricing profile whose review window has closed. */
  readonly notes: readonly string[];
  /** The reviewed profile a seeded request of `operationId` is priced with; throws for an operation not in SEEDED_AI_OPERATIONS. */
  pricingFor(operationId: string): Pricing;
}

export declare function seedAiPricing(app: SeedAiPricingApp, now?: Date): SeedAiPricing;
