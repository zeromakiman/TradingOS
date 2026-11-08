import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A held (uncertain) reservation explained plainly wherever AI is offered for the account (Wave 4a): what happened,
// that nothing beyond the held amount was charged, and what resolves it. The account's AI stays paused until an
// audited resolution (docs/AI_ACCOUNTING_RESOLUTION.md); other unavailability keeps its own copy.

const m = vi.hoisted(() => ({ rpc: vi.fn(), events: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: async () => ({
    db: {
      rpc: m.rpc,
      from: () => {
        const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => m.events() };
        return chain;
      },
    },
    user: { id: "10000000-0000-4000-8000-000000000001" },
  }),
}));
import { HELD_RESERVATION_MESSAGE } from "@/ai/availability";
import { availabilityReason } from "@/components/ai/panel-data";
import { aiBudgetStatus, HELD_RESERVATION_REASON } from "@/components/ai/ai-budget-summary";
import { budgetPresentation, type BudgetSnapshot } from "@/ai/budget";
import { accountAiAvailability } from "@/lib/ai-budget";

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const snapshot = (overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
  enabled: true, budgetCents: 500, usedMicros: 59_400, heldMicros: 0, uncertain: false, period: "2026-10-01", resetAt: "2026-11-01T05:00:00.000Z", ...overrides,
});

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "mock-only");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_mock");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  m.events.mockResolvedValue({ data: [], error: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("held reservation", () => {
  it("pauses the account's AI with its own status and a plain explanation", async () => {
    m.rpc.mockResolvedValue({ data: snapshot({ uncertain: true }), error: null });
    expect(await accountAiAvailability(ACCOUNT, "WEEKLY_REVIEW")).toEqual({ status: "ACCOUNTING_REVIEW", message: HELD_RESERVATION_MESSAGE, deepEnabled: false });
    expect(m.rpc).toHaveBeenCalledWith("get_account_ai_budget", { p_account_id: ACCOUNT });
  });

  it("says what happened, that nothing beyond the held amount was charged, and what resolves it, in trader words", () => {
    for (const text of [HELD_RESERVATION_MESSAGE, HELD_RESERVATION_REASON]) {
      expect(text).toMatch(/ended without a confirmed cost/);
      expect(text).toMatch(/Nothing beyond that amount was charged|nothing beyond that amount was charged/);
      expect(text).toMatch(/accounting review confirms the cost or releases the hold/);
      expect(text).not.toMatch(/reserv|UNCERTAIN|disposition|reservation/i);
    }
    expect(availabilityReason({ status: "ACCOUNTING_REVIEW", message: "x" })).toBe(HELD_RESERVATION_MESSAGE);
    const budget = { snapshot: snapshot({ uncertain: true }), presentation: budgetPresentation(snapshot({ uncertain: true }), true), system: { status: "ENABLED" as const, message: "" } };
    expect(aiBudgetStatus(budget)).toEqual({ label: "Paused — needs review", tone: "warning", reason: HELD_RESERVATION_REASON });
  });

  it("keeps the other states' copy: off, budget reached and configuration problems are not held reservations", async () => {
    m.rpc.mockResolvedValue({ data: snapshot({ enabled: false }), error: null });
    expect((await accountAiAvailability(ACCOUNT, "WEEKLY_REVIEW")).status).toBe("ACCOUNT_OFF");
    m.rpc.mockResolvedValue({ data: snapshot({ usedMicros: 4_990_000 }), error: null });
    expect((await accountAiAvailability(ACCOUNT, "WEEKLY_REVIEW")).status).toBe("BUDGET_REACHED");
    m.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    expect((await accountAiAvailability(ACCOUNT, "WEEKLY_REVIEW")).status).toBe("CONFIGURATION_ERROR");
    m.rpc.mockResolvedValue({ data: snapshot(), error: null });
    expect((await accountAiAvailability(ACCOUNT, "WEEKLY_REVIEW")).status).toBe("ENABLED");
    expect(availabilityReason({ status: "CONFIGURATION_ERROR", message: "AI configuration error" })).toBe("AI is unavailable right now. Other Trading OS workflows are unaffected.");
  });
});
