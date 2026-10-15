import { z } from "zod";

export const AI_BUDGET = { currency: "EUR", defaultCents: 500, minCents: 100, maxCents: 10000, thresholds: [50, 80, 95, 100], disclosure: "AI_DISCLOSURE_V1" } as const;
export const budgetSnapshotSchema = z.object({
 enabled: z.boolean(), budgetCents: z.number().int().min(100).max(10000),
 usedMicros: z.number().int().nonnegative(), heldMicros: z.number().int().nonnegative(),
 uncertain: z.boolean(), period: z.string(), resetAt: z.string(),
});
export type BudgetSnapshot = z.infer<typeof budgetSnapshotSchema>;
export function budgetCents(value: string) {
 if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) throw new Error("Enter a EUR amount from 1.00 to 100.00, with up to two decimal places.");
 const [whole, fraction = ""] = value.split(".");
 const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
 if (cents < AI_BUDGET.minCents || cents > AI_BUDGET.maxCents) throw new Error("Monthly budget must be between €1.00 and €100.00.");
 return cents;
}
export function aiMonth(now: Date) {
 const fixed = new Date(now.getTime() - 5 * 3600000);
 const year = fixed.getUTCFullYear(), month = fixed.getUTCMonth();
 return { period: `${year}-${String(month + 1).padStart(2,"0")}-01`, resetAt: new Date(Date.UTC(year, month + 1, 1, 5)).toISOString() };
}
export function budgetPresentation(budget: BudgetSnapshot, available: boolean) {
 const cap = budget.budgetCents * 10000, committed = budget.usedMicros + budget.heldMicros;
 const percentage = Math.floor(committed / cap * 100);
 const state = !available || budget.uncertain ? "UNAVAILABLE" : !budget.enabled ? "OFF" : committed >= cap ? "BUDGET REACHED" : "ON";
 const warning = percentage >= 100 ? "Limit reached — further AI requests are blocked." : percentage >= 95 ? "95% threshold — almost at the limit." : percentage >= 80 ? "80% threshold — approaching the limit." : percentage >= 50 ? "50% threshold — half of the budget is committed." : "Normal usage";
 return { state, percentage, warning, remainingMicros: Math.max(0, cap - committed) };
}
export function euros(micros: number) { return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(micros / 1000000); }
