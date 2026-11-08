import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as operations from "@/ai/operations";
import * as pricing from "@/ai/pricing";
import { SEEDED_AI_OPERATIONS, seedAiPricing } from "../scripts/local-stack/seed-ai-pricing.mjs";

// scripts/local-stack/seed-v2.mjs writes synthetic AI history through the real ledger RPCs. It prices those requests
// once, before it touches any user (scripts/local-stack/seed-ai-pricing.mjs), never on the clock of each later call:
// at the Mini profile's expiry (2026-11-12) the seed used to throw partway through a user. Every instant here is explicit.

const app = { operations, pricing };
const REVIEWED = new Date("2026-10-17T12:00:00Z");
const AFTER_MINI = ["2026-11-12T00:00:00Z", "2026-11-12T00:00:30Z", "2027-01-05T15:00:00Z"];

describe("seeded AI history pricing", () => {
  it("prices every seeded operation at the given instant while its profile is reviewed, exactly as the gate would", () => {
    const seeded = seedAiPricing(app, REVIEWED);
    expect(seeded.notes).toEqual([]);
    for (const id of SEEDED_AI_OPERATIONS) expect(seeded.pricingFor(id)).toBe(pricing.operationPricing(operations.operationFor(id), REVIEWED));
  });

  it("once the Mini review window has closed, prices the synthetic history at its last reviewed instant and says so", () => {
    for (const at of AFTER_MINI) {
      const now = new Date(at);
      // The app's own gate keeps refusing: this is what the seed's former call threw halfway through a user.
      for (const id of SEEDED_AI_OPERATIONS) expect(() => pricing.operationPricing(operations.operationFor(id), now)).toThrow(/pricing requires review/);
      const seeded = seedAiPricing(app, now);
      for (const id of SEEDED_AI_OPERATIONS) expect(seeded.pricingFor(id)).toBe(pricing.MINI_PRICING);
      expect(seeded.notes).toEqual([expect.stringContaining(`${pricing.MINI_PRICING.version} expired at ${pricing.MINI_PRICING.validUntil}`)]);
    }
    // One millisecond before the window closes nothing has lapsed yet.
    expect(seedAiPricing(app, new Date(Date.parse(pricing.MINI_PRICING.validUntil) - 1)).notes).toEqual([]);
  });

  it("still fails closed on everything else the app checks, and on an operation it was not resolved for", () => {
    const unknownProfile = { operations: { operationFor: (id: string) => ({ ...operations.operationFor(id), pricingProfile: "UNREVIEWED" }) }, pricing };
    const otherModel = { operations: { operationFor: (id: string) => ({ ...operations.operationFor(id), model: "gpt-unreviewed" }) }, pricing };
    for (const now of [REVIEWED, new Date(AFTER_MINI[2])]) {
      expect(() => seedAiPricing(unknownProfile, now)).toThrow(/pricing requires review/);
      expect(() => seedAiPricing(otherModel, now)).toThrow(/pricing requires review/);
    }
    expect(() => seedAiPricing(app, REVIEWED).pricingFor("MONTHLY_REVIEW")).toThrow(/not priced for seeding/);
  });

  it("is the seed's only pricing path, and it covers every operation the seed writes", () => {
    const seed = readFileSync("scripts/local-stack/seed-v2.mjs", "utf8");
    expect(seed).not.toMatch(/operationPricing\(/);
    expect(seed).toMatch(/seedAiPricing\(/);
    const written = new Set([...seed.matchAll(/operation(?:Id)?: "([A-Z_]+)"/g)].map(match => match[1]));
    expect([...written].sort()).toEqual([...SEEDED_AI_OPERATIONS].sort());
  });
});
