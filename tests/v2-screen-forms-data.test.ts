import { beforeEach, describe, expect, it, vi } from "vitest";

// Server loaders of the trade forms (docs/V2_ARCHITECTURE.md §9.2, §14.2, §14.3) and the legacy V1 setup link (§1.2):
// what the browser receives (no locked theses, explicit accounts), how Edit Draft prefills a revision and when it
// refuses, and that the client preview evaluates exactly the context the server check uses. No database, no network.

const m = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  loadWorkspace: vi.fn(),
  accountWorkspace: vi.fn(),
  detail: vi.fn(),
  schema: vi.fn(),
  failure: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: {}, user: { id: "user" } }) }));
vi.mock("@/lib/account-context", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/account-context")>()),
  currentSession: m.session,
  getAccountContext: m.context,
}));
vi.mock("@/lib/workspace", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/workspace")>()),
  loadAccountWorkspace: m.loadWorkspace,
  getAccountWorkspace: m.accountWorkspace,
}));
vi.mock("@/lib/trades-data", () => ({ getTradeDetail: m.detail }));
vi.mock("@/lib/schema-gate", () => ({ getSchemaStatus: m.schema }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.failure }));

import { autosaveScope } from "@/components/trade/forms/autosave";
import { formAccount, loadEditDraft, loadTradeFormData } from "@/components/trade/forms/form-data";
import { legacyProposalTarget, queryString } from "@/components/trade/forms/legacy";
import { draftFromRevision, newPlanDraft, type PlanDraft, previewPlan, rawProposal } from "@/components/trade/forms/plan-model";
import { type DailyUsage, evaluateRisk, type Instrument } from "@/domain/risk";
import { LOCKED_PLAN_NOTE } from "@/domain/trade-state";
import type { ContextAccount } from "@/lib/account-context";
import type { TradeDetail } from "@/lib/trades-data";
import { type AccountWorkspace, riskContextFor } from "@/lib/workspace";

const USER = "c0000000-0000-4000-8000-000000000001";
const FTMO = "a1000000-0000-4000-8000-000000000001";
const DEMO = "a1000000-0000-4000-8000-000000000002";
const OBSERVATION = "b1000000-0000-4000-8000-000000000001";
const RISK_PLAN = "b2000000-0000-4000-8000-000000000001";
const STRATEGY = "b3000000-0000-4000-8000-000000000001";
const TRADE = "d1000000-0000-4000-8000-000000000001";
/** Fri Oct 23, 08:00 UTC−5 (active kill zone). */
const NOW = "2026-10-23T13:00:00.000Z";
const DAY = "2026-10-23";

const EURUSD: Instrument = {
  id: "e1000000-0000-4000-8000-000000000001", symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001",
  tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01",
};
const GBPUSD: Instrument = { ...EURUSD, id: "e1000000-0000-4000-8000-000000000002", symbol: "GBPUSD", quantityUnit: "lots (100,000 GBP)" };

function contextAccount(id: string, overrides: Partial<ContextAccount> = {}): ContextAccount {
  return {
    id, name: "FTMO 100K", currency: "USD", type: "EVALUATION", platform: "MT5", broker: "FTMO", status: "ACTIVE", startingBalance: "100000",
    createdAt: "2026-07-23T12:00:00Z", profile: "PROFILE", ...overrides,
  };
}

function usage(overrides: Partial<DailyUsage> = {}): DailyUsage {
  return {
    day: DAY, plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0, realizedLoss: "0", externalLoss: "0",
    legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0", ...overrides,
  };
}

function workspace(overrides: Partial<AccountWorkspace> = {}): AccountWorkspace {
  return {
    account: contextAccount(FTMO),
    now: NOW,
    day: DAY,
    observation: { id: OBSERVATION, balance: "100000", equity: "100000", grossLossToday: null, tradingDay: DAY, recordedAt: "2026-10-23T12:30:00Z" },
    riskPlan: {
      id: RISK_PLAN, version: "Risk Plan V1.2", maxRiskPercent: "1", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK",
      newsPolicy: "BLOCK", dailyRiskCap: "2500", dailyLossCap: null, effectiveDay: "2026-10-01", createdAt: "2026-10-01T10:00:00Z", overrideReason: null,
    },
    strategy: { id: STRATEGY, version: "ICT V1.0", rules: {} },
    instruments: [EURUSD, GBPUSD],
    usage: usage(),
    todaysPlans: [],
    status: null,
    gaps: [],
    ...overrides,
  };
}

const LOCKED_TODAY = {
  instrumentVersionId: EURUSD.id,
  proposal: {
    instrumentId: EURUSD.id, direction: "LONG", model: "OTE", entry: "1.085", stop: "1.0835", target: "1.09", riskPercent: "0.5",
    narrative: "Locked thesis that must stay on the server.", contractConfirmed: true, news: "CLEAR", contradiction: false,
  },
};

function plan(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    accountId: FTMO, instrumentId: EURUSD.id, direction: "LONG", model: "OTE", entry: "1.08500", stop: "1.08350", target: "1.09000", riskChoice: "0.5", customRisk: "",
    narrative: "London swept the Asian low into the H1 OB; invalid on an M5 close below the sweep.", news: "CLEAR", contractConfirmed: true, contradiction: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.session.mockResolvedValue({ db: {}, user: { id: USER } });
  m.schema.mockResolvedValue({ ready: true, version: "2.1" });
});

describe("formAccount (what the forms send to the browser)", () => {
  it("projects today's plans to the fields the DUPLICATE rule compares, never the locked thesis", () => {
    const account = formAccount(workspace({ todaysPlans: [LOCKED_TODAY] }));
    expect(account.todaysPlans).toEqual([
      { instrumentVersionId: EURUSD.id, proposal: { direction: "LONG", model: "OTE", entry: "1.085", stop: "1.0835", target: "1.09" } },
    ]);
    expect(JSON.stringify(account)).not.toContain("Locked thesis");
  });

  it("carries the expected versions, account values, usage and the engine context without instrument or duplicate", () => {
    const account = formAccount(workspace({ usage: usage({ plannedSlots: 1, unplannedTrades: 1 }) }));
    expect(account).toMatchObject({
      id: FTMO, name: "FTMO 100K", currency: "USD", description: "Evaluation · FTMO", riskPlanId: RISK_PLAN, observationId: OBSERVATION, balance: "100000",
      equity: "100000", observationDay: DAY, strategyVersion: "ICT V1.0", usage: { day: DAY, used: 2, planned: 1, unplanned: 1, max: 2 }, gaps: [],
    });
    expect(account.risk).not.toBeNull();
    expect(account.risk).not.toHaveProperty("instrument");
    expect(account.risk).not.toHaveProperty("duplicate");
    expect(account.riskPlan).toMatchObject({ maxRiskPercent: "1", defaultRiskPercent: "0.5", minRR: "3", version: "Risk Plan V1.2" });
  });

  it("has no engine context while the account lacks values, a risk plan or instruments", () => {
    expect(formAccount(workspace({ observation: null, gaps: ["ACCOUNT_VALUES"] }))).toMatchObject({ risk: null, observationId: null, gaps: ["ACCOUNT_VALUES"] });
    expect(formAccount(workspace({ riskPlan: null, gaps: ["RISK_PLAN"] }))).toMatchObject({ risk: null, riskPlanId: null, usage: null });
    expect(formAccount(workspace({ instruments: [], gaps: ["INSTRUMENTS"] })).risk).toBeNull();
  });
});

describe("preview parity with the server check (spec §6.7, DUPLICATE)", () => {
  // The preview must evaluate exactly the context riskContextFor builds for the stored check of the same proposal.
  const cases: [string, Partial<PlanDraft>, Partial<AccountWorkspace>][] = [
    ["approved", {}, {}],
    ["duplicate of a plan locked today (equal prices, other spelling)", {}, { todaysPlans: [LOCKED_TODAY] }],
    ["same prices, other target", { target: "1.09100" }, { todaysPlans: [LOCKED_TODAY] }],
    ["risk above the maximum", { riskChoice: "custom", customRisk: "1.25" }, {}],
    ["off tick", { entry: "1.085005" }, {}],
    ["restricted news", { news: "RESTRICTED" }, {}],
    ["daily trade limit and risk cap used", {}, { usage: usage({ plannedSlots: 1, unplannedTrades: 1, plannedRisk: "2400" }) }],
  ];
  for (const [name, overrides, context] of cases) {
    it(name, () => {
      const ws = workspace(context);
      const draft = plan(overrides);
      const preview = previewPlan(draft, formAccount(ws), NOW);
      if (preview.kind !== "report") throw new Error(`expected a report, got ${preview.kind}`);
      const proposal = rawProposal(draft);
      const server = evaluateRisk(proposal, riskContextFor(ws, EURUSD, proposal) as NonNullable<ReturnType<typeof riskContextFor>>);
      expect(preview.report).toEqual(server);
    });
  }

  it("blocks the duplicate in the preview, as the server does", () => {
    const preview = previewPlan(plan(), formAccount(workspace({ todaysPlans: [LOCKED_TODAY] })), NOW);
    expect(preview.kind === "report" && preview.blocking.map(issue => issue.code)).toEqual(["DUPLICATE"]);
    const other = previewPlan(plan({ target: "1.09100" }), formAccount(workspace({ todaysPlans: [LOCKED_TODAY] })), NOW);
    expect(other.kind === "report" && other.decision).toBe("APPROVED");
  });
});

describe("loadTradeFormData", () => {
  it("loads every active account at one server time and lists an unreadable one as unavailable", async () => {
    const demo = contextAccount(DEMO, { name: "Demo 100K", type: "DEMO", broker: null });
    m.context.mockResolvedValue({ active: [contextAccount(FTMO), demo], archived: [contextAccount("a1000000-0000-4000-8000-000000000009", { status: "ARCHIVED" })], formDefaultAccountId: FTMO });
    m.loadWorkspace.mockImplementation(async (_db: unknown, userId: string, account: ContextAccount, now: string) => {
      expect(userId).toBe(USER);
      if (account.id === DEMO) throw new Error("boom");
      return workspace({ now });
    });
    const data = await loadTradeFormData();
    expect(data.defaultAccountId).toBe(FTMO);
    expect(data.hasArchived).toBe(true);
    expect(data.accounts.map(account => [account.name, account.gaps])).toEqual([["FTMO 100K", []], ["Demo 100K", ["UNAVAILABLE"]]]);
    expect(data.accounts[1]).toMatchObject({ description: "Demo", instruments: [], risk: null, riskPlanId: null });
    expect(m.failure).toHaveBeenCalledWith("data_read_failed");
    const nows = m.loadWorkspace.mock.calls.map(call => call[3]);
    expect(new Set(nows).size).toBe(1);
    expect(data.now).toBe(nows[0]);
    // Unsaved entries are kept per user in the tab, under a hash: the user id never reaches browser storage.
    expect(data.autosaveScope).toBe(autosaveScope(USER));
    expect(data.autosaveScope).not.toContain(USER);
  });
});

function evidenceItem(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: "M5 chart", label: "PRE_ENTRY", timeframe: "M5", thumbSrc: `/api/evidence/${id}?variant=thumb`, recordedAt: "2026-10-23T12:40:00Z", removedAt: null, ...overrides };
}

function detail(overrides: Record<string, unknown> = {}): TradeDetail {
  const base = {
    tradeId: TRADE,
    title: "EURUSD · Long",
    origin: "PLANNED",
    symbol: "EURUSD",
    instrument: { symbol: "EURUSD" },
    account: { id: FTMO, name: "FTMO 100K", currency: "USD", status: "ACTIVE" },
    plan: null,
    state: { lifecycle: "DRAFT", label: "Blocked", tone: "danger", originLabel: "Planned", immutableNote: null },
    draft: {
      revision: 2, expectedRevision: 2, createdAt: "2026-10-23T12:45:00Z", latestCheck: null, checkCurrent: false,
      proposal: {
        instrumentVersionId: EURUSD.id, direction: "SHORT", model: "OB_FIRST_TOUCH", entry: "1.08500", stop: "1.08650", target: "1.08000", riskPercent: "0.4",
        narrative: "Revised thesis.", contractConfirmed: true, news: "UNKNOWN", contradiction: false,
      },
    },
    evidence: { items: [evidenceItem("f1000000-0000-4000-8000-000000000001"), evidenceItem("f1000000-0000-4000-8000-000000000002", { removedAt: "2026-10-23T12:50:00Z" })], activeCount: 1, limit: 24 },
    ai: {
      history: {
        latestRevision: 2,
        preTrade: [
          { number: 2, currentNumber: 2, isLatestRevision: true, staleLabel: null, rows: [{ status: "COMPLETED" }, { status: "FAILED" }, { status: "IN_PROGRESS" }] },
          { number: 1, currentNumber: 2, isLatestRevision: false, staleLabel: "Based on draft revision 1 · current revision is 2", rows: [{ status: "COMPLETED" }] },
        ],
        reviews: [],
        error: null,
      },
    },
  };
  return { ...base, ...overrides } as unknown as TradeDetail;
}

describe("loadEditDraft", () => {
  beforeEach(() => m.accountWorkspace.mockResolvedValue(workspace()));

  it("is null (404) for a trade that is not the user's", async () => {
    m.detail.mockResolvedValue(null);
    expect(await loadEditDraft(TRADE)).toBeNull();
  });

  it("prefills the latest revision with the next revision, the expected revision, active screenshots and current AI analyses", async () => {
    m.detail.mockResolvedValue(detail());
    const loaded = await loadEditDraft(TRADE);
    if (loaded?.kind !== "draft") throw new Error("expected a draft");
    const { data } = loaded;
    expect(data).toMatchObject({ tradeId: TRADE, title: "EURUSD · Long", revision: 2, expectedRevision: 2, stateLabel: "Blocked", archived: false, contractUpdated: null, evidenceCapacity: 23 });
    // Completed and running analyses of revision 2 count; the failed one and revision 1's do not.
    expect(data.aiAnalysesOfRevision).toBe(2);
    expect(data.evidence).toEqual([{ id: "f1000000-0000-4000-8000-000000000001", name: "M5 chart", tag: "Pre-entry · M5", thumbSrc: "/api/evidence/f1000000-0000-4000-8000-000000000001?variant=thumb", recordedAt: "2026-10-23T12:40:00Z" }]);
    expect(data.prefill).toEqual({
      instrumentId: EURUSD.id, direction: "SHORT", model: "OB_FIRST_TOUCH", entry: "1.08500", stop: "1.08650", target: "1.08000", riskPercent: "0.4",
      narrative: "Revised thesis.", contractConfirmed: true, news: "UNKNOWN", contradiction: false,
    });
    // 0.4% is not a preset: the form opens it as Custom; the account stays the trade's account.
    expect(draftFromRevision(data.prefill, data.account)).toMatchObject({ accountId: FTMO, riskChoice: "custom", customRisk: "0.4", contractConfirmed: true });
    expect(data.autosaveScope).toBe(autosaveScope(USER));
  });

  it("moves a superseded contract to the symbol's current version and asks to confirm it again", async () => {
    const old = "e1000000-0000-4000-8000-0000000000aa";
    m.detail.mockResolvedValue(detail({ draft: { ...detail().draft, proposal: { ...detail().draft?.proposal, instrumentVersionId: old } } }));
    const loaded = await loadEditDraft(TRADE);
    if (loaded?.kind !== "draft") throw new Error("expected a draft");
    expect(loaded.data.prefill).toMatchObject({ instrumentId: EURUSD.id, contractConfirmed: false });
    expect(loaded.data.contractUpdated).toEqual({ symbol: "EURUSD" });
  });

  it("explains in words why locked plans, live-first trades, discarded and skipped drafts can't be edited", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ plan: { lockedAt: "x" }, draft: null, state: { lifecycle: "LOCKED", label: "Locked · waiting for entry", tone: "info", originLabel: "Planned", immutableNote: LOCKED_PLAN_NOTE } }, LOCKED_PLAN_NOTE],
      [{ origin: "LIVE_FIRST", draft: null, state: { lifecycle: "LIVE", label: "Live", tone: "live", originLabel: "Live-first", immutableNote: null } }, "Live-first trades have no pre-trade draft to edit. Missing entry details can be added on the trade page."],
      [{ draft: null, state: { lifecycle: "DISCARDED", label: "Discarded", tone: "muted", originLabel: "Planned", immutableNote: null } }, "This draft was discarded, so it can't be edited. Duplicate it from the trade page to plan it again."],
      [{ draft: null, state: { lifecycle: "SKIPPED", label: "Skipped", tone: "muted", originLabel: "Planned", immutableNote: null } }, "This draft was skipped, so it can't be edited. Duplicate it from the trade page to plan it again."],
    ];
    for (const [overrides, reason] of cases) {
      m.detail.mockResolvedValue(detail(overrides));
      const loaded = await loadEditDraft(TRADE);
      expect(loaded?.kind).toBe("not-editable");
      expect(loaded?.data).toMatchObject({ tradeId: TRADE, reason });
    }
    expect(m.accountWorkspace).not.toHaveBeenCalled();
  });
});

describe("legacy /analyze/[id] (spec §1.2)", () => {
  function db(row: unknown, error: unknown = null) {
    const calls: unknown[][] = [];
    const chain = {
      select(...args: unknown[]) {
        calls.push(["select", ...args]);
        return chain;
      },
      eq(...args: unknown[]) {
        calls.push(["eq", ...args]);
        return chain;
      },
      maybeSingle: async () => ({ data: row, error }),
    };
    const client = {
      from(table: string) {
        calls.push(["from", table]);
        return chain;
      },
    };
    return { calls, client };
  }

  it("resolves the proposal to its trade with the user's session and an owner filter", async () => {
    const fake = db({ trade_id: TRADE });
    m.session.mockResolvedValue({ db: fake.client, user: { id: USER } });
    expect(await legacyProposalTarget("B1000000-0000-4000-8000-0000000000FF")).toEqual({ kind: "trade", tradeId: TRADE });
    expect(fake.calls).toEqual([["from", "trade_revisions"], ["select", "trade_id"], ["eq", "proposal_id", "b1000000-0000-4000-8000-0000000000ff"], ["eq", "user_id", USER]]);
  });

  it("answers not found for another user's or a malformed proposal, and defers to the app on an outdated database", async () => {
    m.session.mockResolvedValue({ db: db(null).client, user: { id: USER } });
    expect(await legacyProposalTarget("b1000000-0000-4000-8000-0000000000ff")).toEqual({ kind: "not-found" });
    m.session.mockClear();
    expect(await legacyProposalTarget("not-a-proposal")).toEqual({ kind: "not-found" });
    expect(m.session).not.toHaveBeenCalled();
    m.schema.mockResolvedValue({ ready: false, reason: "MISSING", version: null });
    expect(await legacyProposalTarget("b1000000-0000-4000-8000-0000000000ff")).toEqual({ kind: "schema-outdated" });
  });

  it("keeps the query string of /analyze", () => {
    expect(queryString({})).toBe("");
    expect(queryString({ account: FTMO, tag: ["a", "b"], empty: undefined })).toBe(`?account=${FTMO}&tag=a&tag=b`);
  });
});

describe("new drafts", () => {
  it("preselect the risk-plan default and an account's only instrument", () => {
    const one = formAccount(workspace({ instruments: [EURUSD] }));
    expect(newPlanDraft(one)).toMatchObject({ accountId: FTMO, instrumentId: EURUSD.id, riskChoice: "0.5", news: "UNKNOWN", contractConfirmed: false, contradiction: false });
    expect(newPlanDraft(formAccount(workspace())).instrumentId).toBe("");
    expect(newPlanDraft(null)).toMatchObject({ accountId: "", instrumentId: "", riskChoice: "", customRisk: "" });
  });
});
