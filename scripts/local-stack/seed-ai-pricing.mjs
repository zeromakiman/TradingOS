// Pricing of the AI history seed-v2.mjs writes: synthetic usage through the real ledger RPCs; no provider is called.
//
// The seed records its AI requests now (the RPCs stamp clock_timestamp()), and the app prices a request when it reserves
// it (operationPricing in src/ai/pricing.ts), so the seed prices at now while every reviewed profile it uses is inside
// its review window. From a profile's validUntil on, the app refuses new requests until the pricing is reviewed; the
// seed then prices its synthetic history at that profile's last reviewed instant instead of stopping partway through a
// user, and says so. Every other check the app makes (unknown profile, provider or model mismatch, operation bounds)
// still throws, and seed-v2.mjs resolves this once, before it touches any user.

/** The operations whose requests seed-v2.mjs writes (ai.preTrade, ai.timeline and ai.weekly). */
export const SEEDED_AI_OPERATIONS = Object.freeze(["ANALYZE_SETUP", "CHALLENGE_BIAS", "REVIEW_TRADE_TIMELINE", "WEEKLY_REVIEW"]);

/**
 * `app` carries the application's own src/ai/operations.ts (`operations`) and src/ai/pricing.ts (`pricing`) modules.
 * Returns the reviewed profile each seeded operation is priced with and one note per profile whose window has closed.
 */
export function seedAiPricing(app, now = new Date()) {
  const priced = new Map();
  const lapsed = new Map();
  for (const id of SEEDED_AI_OPERATIONS) {
    const operation = app.operations.operationFor(id);
    const profile = app.pricing.PRICING_PROFILES[operation.pricingProfile];
    const closes = profile ? Date.parse(profile.validUntil) : Number.NaN;
    // operationPricing refuses from validUntil on; the last reviewed instant is the millisecond before it.
    const at = now.getTime() >= closes ? new Date(closes - 1) : now;
    if (at !== now) lapsed.set(profile.version, profile.validUntil);
    try {
      priced.set(id, app.pricing.operationPricing(operation, at));
    } catch (error) {
      throw new Error(`The seeded ${id} requests cannot be priced (src/ai/pricing.ts): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    notes: [...lapsed].map(([version, validUntil]) =>
      `AI pricing ${version} expired at ${validUntil}: the app refuses new AI requests until src/ai/pricing.ts is reviewed. The seeded AI history (synthetic usage, no provider) is priced at its last reviewed instant.`),
    /** The reviewed profile a seeded request of `operationId` is priced with. */
    pricingFor(operationId) {
      const pricing = priced.get(operationId);
      if (!pricing) throw new Error(`${operationId} is not priced for seeding: add it to SEEDED_AI_OPERATIONS in scripts/local-stack/seed-ai-pricing.mjs`);
      return pricing;
    },
  };
}
