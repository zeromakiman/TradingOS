import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_OPERATIONS, operationFor } from "@/ai/operations";
import { operationPricing } from "@/ai/pricing";

// Wave 4a (1b c): the V1 trade review (REVIEW_TRADE) and the legacy setup evaluator have no trading-directive check in
// their validators, so neither may be startable from V2. REVIEW_TRADE keeps only its history; the legacy evaluator
// route stays unlinked and refuses before any provider traffic since its pricing profile expired.

const SRC = join(process.cwd(), "src");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const files = sources(SRC).map(path => ({ path: relative(process.cwd(), path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));

describe("AI operations V2 cannot start", () => {
  it("nothing calls the V1 trade review's start, authorize or finish RPCs; its rows are only read (history, export)", () => {
    expect(files.filter(file => /(start|authorize|finish)_trade_ai_review(?![a-z_])/.test(file.text)).map(file => file.path)).toEqual([]);
  });

  it("no page, component or action links the legacy evaluator route", () => {
    expect(files.filter(file => file.text.includes("/api/setups/") && !file.path.startsWith("src/app/api/setups/")).map(file => file.path)).toEqual([]);
  });

  it("the legacy evaluator's operations refuse before any provider traffic: their pricing profile has expired", () => {
    const legacy = Object.values(AI_OPERATIONS).filter(operation => operation.contract === "SETUP_V2");
    expect(legacy.map(operation => operation.id).sort()).toEqual(["SETUP_ANALYSIS", "SETUP_CHALLENGE", "SETUP_RECONCILE"]);
    for (const operation of legacy) expect(() => operationPricing(operation, new Date("2026-10-22T00:00:00Z"))).toThrow(/pricing requires review/);
    // The V2 operations keep valid pricing at the same time.
    expect(() => operationPricing(operationFor("WEEKLY_REVIEW"), new Date("2026-10-22T00:00:00Z"))).not.toThrow();
  });
});
