import { createElement, type KeyboardEvent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Plan Trade, Edit Draft and Record Live Trade (docs/V2_ARCHITECTURE.md §6.5–6.6, §7.1, §8.1–8.3, §9.2, §14.2, §14.3,
// §15) and the legacy /analyze and /preview routes (§1.2): the pure form models, the server-rendered screens with mocked
// loaders and actions, and the pages. No database, no network.

const m = vi.hoisted(() => ({
  formData: vi.fn(),
  editDraft: vi.fn(),
  detail: vi.fn(),
  legacy: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  actions: { createPlannedTrade: vi.fn(), reviseDraft: vi.fn(), recordLiveTrade: vi.fn() },
  confirmValues: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: {}, user: { id: "user" } }) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: m.replace, refresh: m.refresh, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/trades/new",
}));
vi.mock("@/app/actions/trades", () => m.actions);
vi.mock("@/app/actions/accounts", () => ({ confirmAccountValuesUnchanged: m.confirmValues }));
vi.mock("@/components/trade/forms/form-data", () => ({ loadTradeFormData: m.formData, loadEditDraft: m.editDraft }));
vi.mock("@/components/trade/forms/legacy", async importOriginal => ({
  ...(await importOriginal<typeof import("@/components/trade/forms/legacy")>()),
  legacyProposalTarget: m.legacy,
}));
vi.mock("@/lib/trades-data", () => ({ getTradeDetail: m.detail }));
vi.mock("@/lib/account-context", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/account-context")>()),
  getPreferences: async () => ({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false }),
}));

import EditDraftPage, { generateMetadata as editMetadata } from "@/app/(app)/trades/[id]/edit/page";
import RecordLiveTradePage from "@/app/(app)/trades/live/new/page";
import PlanTradePage from "@/app/(app)/trades/new/page";
import LegacySetupNotFound from "@/app/analyze/[id]/not-found";
import LegacySetupPage from "@/app/analyze/[id]/page";
import LegacyAnalyzePage from "@/app/analyze/page";
import LegacyPreviewPage from "@/app/preview/page";
import {
  autosaveKey, autosaveScope, clearFormAutosaves, entriesToKeep, pruneAutosaves, readAutosave, removeAutosave, restorableEntries, restoreLiveDraft, restorePlanDraft,
  sameDraft, writeAutosave,
} from "@/components/trade/forms/autosave";
import {
  aiRevisionWarning, CONTRACT_LABEL, CONTRADICTION_LABEL, GAP_COPY, LEGACY_LINK_DESCRIPTION, LEGACY_LINK_TITLE, LIVE_FIELD_COPY, LIVE_TITLE, MODEL_LABELS, NEWS_LABELS,
  PLAN_FIELD_COPY, PLAN_TITLE, PRICE_LATER, RESTORED_TITLE, revisionStep, START_LIVE_JOURNAL, strategyTimeHint, THESIS_PLACEHOLDER, TIMING_LABELS, TIMING_NOW_HINT,
  TIMING_UNKNOWN_HINT,
} from "@/components/trade/forms/copy";
import { blocksPlainEnter, formKeyDown } from "@/components/trade/forms/form-parts";
import { LIMIT_REACHED_BODY, LiveTradeForm, limitReachedTitle, liveUsageText } from "@/components/trade/forms/live-trade-form";
import {
  derivedLiveRisk, type LiveDraft, liveTradeForm, newLiveDraft, OTHER_SYMBOL, strategyWallTime, switchLiveAccount, validateLive, wallTimeToInstant, withPriceLater,
} from "@/components/trade/forms/live-model";
import { NO_ACCOUNT_TITLE, NoTradingAccount, noAccountDescription } from "@/components/trade/forms/no-account";
import { NOT_EDITABLE_TITLE, NotEditableView } from "@/components/trade/forms/not-editable";
import {
  budgetHint, CUSTOM_RISK, contractSummary, draftFromRevision, listInputs, newPlanDraft, type PlanDraft, planFieldErrors, previewPlan, previewSummary, priceHints,
  riskChoiceFor, riskPresets, switchPlanAccount, unitWord, validatePlan,
} from "@/components/trade/forms/plan-model";
import { PlanTradeForm, type PlanTradeFormProps, unchangedMessage } from "@/components/trade/forms/plan-trade-form";
import { contextLine, findingsSummary, lastValuesText } from "@/components/trade/forms/risk-preview";
import { SavedEvidence, savedEvidenceSummary } from "@/components/trade/forms/saved-evidence";
import type { EditDraftData, FormAccount } from "@/components/trade/forms/types";
import type { DailyUsage, Instrument } from "@/domain/risk";
import { LOCKED_PLAN_NOTE } from "@/domain/trade-state";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------------------------------
const FTMO = "a1000000-0000-4000-8000-000000000001";
const DEMO = "a1000000-0000-4000-8000-000000000002";
const OBSERVATION = "b1000000-0000-4000-8000-000000000001";
const RISK_PLAN = "b2000000-0000-4000-8000-000000000001";
const STRATEGY = "b3000000-0000-4000-8000-000000000001";
const TRADE = "d1000000-0000-4000-8000-000000000001";
/** Fri Oct 23, 08:00 UTC−5 (active kill zone). */
const NOW = "2026-10-23T13:00:00.000Z";
/** Fri Oct 23, 14:00 UTC−5 (Dead Pool). */
const DEAD_POOL = "2026-10-23T19:00:00.000Z";
const DAY = "2026-10-23";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`OB_FIRST_TOUCH`, `STALE_EQUITY`, `PRE_ENTRY`): never in visible text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

const EURUSD: Instrument = {
  id: "e1000000-0000-4000-8000-000000000001", symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001",
  tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01",
};
const GBPUSD: Instrument = { ...EURUSD, id: "e1000000-0000-4000-8000-000000000002", symbol: "GBPUSD", quantityUnit: "lots (100,000 GBP)" };
const DEMO_EURUSD: Instrument = { ...EURUSD, id: "e2000000-0000-4000-8000-000000000001" };

const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const render = (element: ReactElement) => renderToStaticMarkup(element);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function expectClean(markup: string) {
  const text = visibleText(markup);
  expect(text).not.toMatch(UUID);
  expect(text).not.toMatch(ENUM);
  expect(count(markup, "<h1")).toBe(1);
}

function usage(overrides: Partial<DailyUsage> = {}): DailyUsage {
  return {
    day: DAY, plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0, realizedLoss: "0", externalLoss: "0",
    legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0", ...overrides,
  };
}

interface AccountOptions extends Partial<FormAccount> {
  rrPolicy?: "BLOCK" | "WARN";
  observationDay?: string;
  usageOverrides?: Partial<DailyUsage>;
}

function account({ rrPolicy = "BLOCK", observationDay = DAY, usageOverrides = {}, ...overrides }: AccountOptions = {}): FormAccount {
  const day = usage(usageOverrides);
  return {
    id: FTMO, name: "FTMO 100K", currency: "USD", description: "Evaluation · FTMO", instruments: [EURUSD, GBPUSD],
    riskPlan: { version: "Risk Plan V1.2", maxRiskPercent: "1", defaultRiskPercent: "0.5", minRR: "3", rrPolicy, newsPolicy: "BLOCK", maxDailyTrades: 2, dailyRiskCap: "2500", dailyLossCap: null },
    risk: {
      now: NOW, strategyVersionId: STRATEGY, strategyVersion: "ICT V1.0", observationId: OBSERVATION, observationDay, equity: "100000", currency: "USD",
      plan: { id: RISK_PLAN, version: "Risk Plan V1.2", maxRiskPercent: "1", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy, newsPolicy: "BLOCK", dailyRiskCap: "2500", dailyLossCap: null },
      usage: day,
    },
    todaysPlans: [],
    riskPlanId: RISK_PLAN,
    observationId: OBSERVATION,
    balance: "100000",
    equity: "100000",
    observationDay,
    strategyVersion: "ICT V1.0",
    usage: { day: day.day, used: day.plannedSlots + day.unplannedTrades, planned: day.plannedSlots, unplanned: day.unplannedTrades, max: 2 },
    gaps: [],
    ...overrides,
  };
}

const demo = () => account({ id: DEMO, name: "Demo 100K", description: "Demo", instruments: [DEMO_EURUSD] });

function plan(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    accountId: FTMO, instrumentId: EURUSD.id, direction: "LONG", model: "OTE", entry: "1.08500", stop: "1.08350", target: "1.09000", riskChoice: "0.5", customRisk: "",
    narrative: "London swept the Asian low into the H1 OB; invalid on an M5 close below the sweep.", news: "CLEAR", contractConfirmed: true, contradiction: false,
    ...overrides,
  };
}

function planForm(props: Partial<PlanTradeFormProps> = {}) {
  return createElement(PlanTradeForm, { now: NOW, accounts: [account(), demo()], initial: plan(), mode: { kind: "create" }, evidenceCapacity: 24, ...props });
}

function live(overrides: Partial<LiveDraft> = {}): LiveDraft {
  return {
    accountId: FTMO, instrumentId: EURUSD.id, symbol: "", direction: "LONG", entryPrice: "1.08500", priceLater: false, timing: "now", enteredAt: "", quantity: "",
    initialStop: "", riskAmount: "", entryModel: "", ...overrides,
  };
}

async function digestOf(run: () => unknown): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : String(error);
  }
  return null;
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------------------------------------------------
// Copy (spec §14.2, §14.3, §15).
// ---------------------------------------------------------------------------------------------------------------------
describe("copy", () => {
  it("uses the exact strings of the spec", () => {
    expect(THESIS_PLACEHOLDER).toBe("Why this trade? What would invalidate it?");
    expect(Object.values(NEWS_LABELS)).toEqual(["Not checked", "Checked · clear", "Restricted window"]);
    expect(CONTRACT_LABEL).toBe("Contract values match my broker");
    expect(CONTRADICTION_LABEL).toBe("My setup contradicts a strategy rule");
    expect(PRICE_LATER).toBe("Already open — add price later");
    expect(START_LIVE_JOURNAL).toBe("Start live journal");
    expect(MODEL_LABELS).toEqual({ OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other" });
    expect(revisionStep(2)).toBe("Revision 2 → 3");
    expect(aiRevisionWarning(2)).toBe("Saving creates revision 3; existing AI analysis will be marked as belonging to revision 2");
    // Saving an unchanged draft creates no revision (it would only make existing AI analysis look stale).
    expect(unchangedMessage(2)).toBe("Nothing changed since revision 2. To check it again with today's values, use Check risk on the trade page.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan model.
// ---------------------------------------------------------------------------------------------------------------------
describe("risk presets (0.25 0.50 0.75 1.00, at most the plan maximum, default preselected)", () => {
  it("filters to the maximum and adds a default that is not a preset", () => {
    expect(riskPresets({ maxRiskPercent: "1", defaultRiskPercent: "0.75" })).toEqual(["0.25", "0.5", "0.75", "1"]);
    expect(riskPresets({ maxRiskPercent: "0.5", defaultRiskPercent: "0.4" })).toEqual(["0.25", "0.4", "0.5"]);
    // Legacy versions without a default: the default is the maximum.
    expect(riskPresets({ maxRiskPercent: "0.3", defaultRiskPercent: null })).toEqual(["0.25", "0.3"]);
    expect(riskPresets(null)).toEqual(["0.25", "0.5", "0.75", "1"]);
  });

  it("maps a stored percent to its chip, or Custom", () => {
    const presets = ["0.25", "0.5", "0.75", "1"];
    expect(riskChoiceFor("0.50", presets)).toEqual({ riskChoice: "0.5", customRisk: "" });
    expect(riskChoiceFor("0.4", presets)).toEqual({ riskChoice: CUSTOM_RISK, customRisk: "0.4" });
    expect(riskChoiceFor(null, presets)).toEqual({ riskChoice: "", customRisk: "" });
    expect(newPlanDraft(account())).toMatchObject({ riskChoice: "0.5", instrumentId: "", news: "UNKNOWN", contractConfirmed: false });
  });
});

describe("drafts", () => {
  it("prefill a revision, and a missing contract is not confirmed", () => {
    const prefill = {
      instrumentId: EURUSD.id, direction: "SHORT" as const, model: "OTE" as const, entry: "1.1", stop: "1.2", target: "1", riskPercent: "1", narrative: "Why",
      contractConfirmed: true, news: "RESTRICTED" as const, contradiction: true,
    };
    expect(draftFromRevision(prefill, account())).toEqual({
      accountId: FTMO, instrumentId: EURUSD.id, direction: "SHORT", model: "OTE", entry: "1.1", stop: "1.2", target: "1", riskChoice: "1", customRisk: "", narrative: "Why",
      news: "RESTRICTED", contractConfirmed: true, contradiction: true,
    });
    expect(draftFromRevision({ ...prefill, instrumentId: null }, account())).toMatchObject({ instrumentId: "", contractConfirmed: false });
  });

  it("keep the symbol when moving to another account, and ask to confirm its contract again", () => {
    const moved = switchPlanAccount(plan(), demo(), [account(), demo()]);
    expect(moved).toMatchObject({ accountId: DEMO, instrumentId: DEMO_EURUSD.id, contractConfirmed: false, entry: "1.08500", riskChoice: "0.5" });
    const base = account().riskPlan;
    if (!base) throw new Error("fixture without a risk plan");
    const lowMax = account({ id: DEMO, riskPlan: { ...base, maxRiskPercent: "0.5", defaultRiskPercent: "0.25" } });
    expect(switchPlanAccount(plan({ riskChoice: "1" }), lowMax, [account(), lowMax])).toMatchObject({ riskChoice: "0.25" });
  });

  it("validate with the engine's field sentences and send the 11 proposal keys", () => {
    const empty = newPlanDraft(account());
    expect(planFieldErrors(empty, account())).toEqual({
      instrumentId: PLAN_FIELD_COPY.instrumentId, direction: PLAN_FIELD_COPY.direction, model: PLAN_FIELD_COPY.model, entry: PLAN_FIELD_COPY.entry,
      target: PLAN_FIELD_COPY.target, narrative: PLAN_FIELD_COPY.narrative,
    });
    expect(planFieldErrors(plan({ entry: "1,5", stop: "abc", riskChoice: CUSTOM_RISK, customRisk: "" }), account())).toEqual({
      entry: PLAN_FIELD_COPY.entry, stop: PLAN_FIELD_COPY.stop, riskPercent: PLAN_FIELD_COPY.riskPercent,
    });
    expect(planFieldErrors(plan(), null)).toMatchObject({ accountId: "Choose a trading account.", instrumentId: PLAN_FIELD_COPY.instrumentId });
    const valid = validatePlan(plan({ stop: " " }), account());
    expect(valid).toEqual({
      ok: true,
      proposal: {
        instrumentId: EURUSD.id, direction: "LONG", model: "OTE", entry: "1.08500", stop: null, target: "1.09000", riskPercent: "0.5",
        narrative: "London swept the Asian low into the H1 OB; invalid on an M5 close below the sweep.", contractConfirmed: true, news: "CLEAR", contradiction: false,
      },
    });
  });
});

describe("hints", () => {
  it("state the tick size, distance in pips, side and RR without colour alone", () => {
    expect(priceHints(plan(), EURUSD, "3")).toEqual({
      entry: { text: "Tick size 0.00001", warning: false },
      stop: { text: "15 pips below entry", warning: false },
      target: { text: "50 pips above entry · 3.33R", warning: false },
    });
    expect(priceHints(plan({ stop: "1.08600" }), EURUSD, "3").stop).toEqual({ text: "For a long trade, the stop must be below entry.", warning: true });
    expect(priceHints(plan({ entry: "1.085005" }), EURUSD, "3").entry).toEqual({ text: "Not on the EURUSD tick size of 0.00001.", warning: true });
    expect(priceHints(plan({ stop: "" }), EURUSD, "3").stop).toEqual({ text: "Tick size 0.00001 · required to lock the plan", warning: false });
    expect(priceHints(plan(), null, "3")).toEqual({ entry: null, stop: null, target: null });
  });

  it("show the risk budget, the maximum and the contract summary", () => {
    expect(budgetHint("0.5", account())).toEqual({ text: "0.50% of $100,000.00 equity = $500.00 risk budget", warning: false });
    expect(budgetHint("1.25", account())).toEqual({ text: "Above your 1.00% maximum: the risk check will block this plan.", warning: true });
    expect(budgetHint("x", account())).toBeNull();
    expect(contractSummary(EURUSD)).toBe("EURUSD: tick size 0.00001 · tick value $1.00 · size in lots (100,000 EUR), step 0.01, minimum 0.01");
    expect(unitWord("lots (100,000 EUR)")).toBe("lots");
    expect(unitWord("contracts")).toBe("contracts");
  });
});

describe("live preview (TypeScript engine 1.2 on the server context)", () => {
  it("sizes an approved plan with verdict-preserving numbers", () => {
    const preview = previewPlan(plan(), account(), NOW);
    if (preview.kind !== "report") throw new Error(preview.kind);
    expect(preview.decision).toBe("APPROVED");
    expect(preview.blocking).toEqual([]);
    expect(preview.stats).toEqual({
      quantity: "3.33", unit: "lots (100,000 EUR)", unitWord: "lots", risk: "$499.50", riskOfEquity: "0.50%", requestedRisk: "0.50%", rr: "3.33R", rrState: "pass",
      minRR: "3.00R", stopDistance: "15 pips · 150 ticks", reward: "$1,665.00", budget: "$500.00",
    });
    expect(preview.notes.map(note => note.title)).toEqual(["No daily loss limit", "Costs not included"]);
    expect(previewSummary(preview)).toEqual({ tone: "positive", label: "Approved", detail: "3.33 lots · $499.50 risk · 3.33R" });
  });

  it("blocks a plan identical to one locked today (DUPLICATE), as the server check does", () => {
    const locked = { instrumentVersionId: EURUSD.id, proposal: { direction: "LONG", model: "OTE", entry: "1.085", stop: "1.0835", target: "1.09" } };
    const preview = previewPlan(plan(), account({ todaysPlans: [locked] }), NOW);
    if (preview.kind !== "report") throw new Error(preview.kind);
    expect(preview.decision).toBe("BLOCKED");
    expect(preview.blocking.map(issue => [issue.title, issue.detail])).toEqual([
      ["Duplicate plan", "An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today."],
    ]);
    const other = previewPlan(plan({ model: "OB_FIRST_TOUCH" }), account({ todaysPlans: [locked] }), NOW);
    expect(other.kind === "report" && other.decision).toBe("APPROVED");
  });

  it("explains blocks with the exact sentences, BLOCK first", () => {
    const preview = previewPlan(plan({ riskChoice: CUSTOM_RISK, customRisk: "1.25", target: "1.08800", contractConfirmed: false }), account(), NOW);
    if (preview.kind !== "report") throw new Error(preview.kind);
    expect(preview.blocking.map(issue => issue.detail)).toEqual([
      "Confirm that the EURUSD contract values match your broker.",
      "Requested risk 1.25% exceeds your configured maximum of 1.00%.",
      "Planned RR 2.00R is below the required minimum of 3.00R.",
    ]);
    expect(preview.stats?.rrState).toBe("block");
    expect(previewSummary(preview)).toEqual({ tone: "negative", label: "Blocked", detail: "Contract values not confirmed · +2 more" });
  });

  it("keeps an RR below a WARN-policy minimum approved, with a warning", () => {
    const preview = previewPlan(plan({ target: "1.08900" }), account({ rrPolicy: "WARN" }), NOW);
    if (preview.kind !== "report") throw new Error(preview.kind);
    expect(preview.decision).toBe("APPROVED");
    expect(preview.stats).toMatchObject({ rr: "2.66R", rrState: "warn" });
    expect(preview.warnings.map(issue => issue.detail)).toEqual(["Planned RR 2.66R is below your 3.00R minimum. Your risk plan allows it with a warning."]);
  });

  it("names what is missing and the blocks that apply to any plan right now", () => {
    const preview = previewPlan(newPlanDraft(account()), account(), DEAD_POOL);
    expect(preview).toMatchObject({ kind: "incomplete", missing: ["instrument", "direction", "model", "entry", "stop", "target"] });
    expect(preview.kind === "incomplete" && preview.blockers.map(issue => issue.title)).toEqual(["Dead Pool"]);
    expect(listInputs(["entry", "stop", "target"])).toBe("entry, stop loss and target");
    expect(previewSummary(preview)).toEqual({ tone: "negative", label: "Blocked", detail: "Dead Pool" });
    expect(previewSummary(previewPlan(newPlanDraft(account()), account(), NOW))).toEqual({ tone: "neutral", label: "Incomplete", detail: "Add the instrument and direction…" });
  });

  it("previews with a stand-in thesis but reports that saving needs one", () => {
    const preview = previewPlan(plan({ narrative: "  " }), account(), NOW);
    expect(preview.kind === "report" && [preview.decision, preview.thesisMissing]).toEqual(["APPROVED", true]);
  });

  it("never judges another day's usage, an account without setup, or no account", () => {
    expect(previewPlan(plan(), account({ usageOverrides: { day: "2026-10-22" } }), NOW)).toEqual({ kind: "new-day" });
    expect(previewPlan(plan(), account({ risk: null, gaps: ["ACCOUNT_VALUES"] }), NOW)).toEqual({ kind: "unavailable", gaps: ["ACCOUNT_VALUES"] });
    expect(previewPlan(plan(), account({ risk: null }), NOW)).toEqual({ kind: "unavailable", gaps: ["UNAVAILABLE"] });
    expect(previewPlan(plan(), null, NOW)).toEqual({ kind: "no-account" });
  });

  it("summarizes the account's day and the collapsed findings", () => {
    expect(contextLine(account({ usageOverrides: { plannedSlots: 1, plannedRisk: "499.5" } }), NOW)).toBe("FTMO 100K · Risk Plan V1.2 · 1 of 2 trades left today · $2,000.50 daily risk left");
    expect(findingsSummary(2, 1)).toBe("2 warnings · 1 note");
    expect(findingsSummary(0, 3)).toBe("3 notes");
    expect(lastValuesText(account({ balance: "100000", equity: "99500.5" }))).toBe("Balance $100,000.00 · equity $99,500.50");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Live model.
// ---------------------------------------------------------------------------------------------------------------------
describe("Record Live Trade model", () => {
  it("sends now (resolved by the server) or the strategy-time instant the trader typed, never a browser time", () => {
    expect(validateLive(live(), account(), NOW)).toEqual({ ok: true, fields: { accountId: FTMO, instrumentId: EURUSD.id, direction: "LONG", entryPrice: "1.08500", enteredAt: "now" } });
    const earlier = validateLive(live({ timing: "earlier", enteredAt: "2026-10-23T07:30" }), account(), NOW);
    expect(earlier.ok && earlier.fields.enteredAt).toBe("2026-10-23T07:30:00-05:00");
    expect(validateLive(live({ timing: "earlier", enteredAt: "2026-10-23T08:30" }), account(), NOW)).toEqual({ ok: false, fieldErrors: { enteredAt: LIVE_FIELD_COPY.enteredAtFuture } });
    expect(validateLive(live({ timing: "earlier", enteredAt: "" }), account(), NOW)).toEqual({ ok: false, fieldErrors: { enteredAt: LIVE_FIELD_COPY.enteredAt } });
    expect(strategyWallTime(NOW)).toBe("2026-10-23T08:00");
    expect(wallTimeToInstant("2026-02-30T10:00")).toBeNull();
  });

  it("sends no entry time when the trader isn't sure (spec §5.3, §8.2: entry time if known)", () => {
    expect(validateLive(live({ timing: "unknown", enteredAt: "2026-10-23T07:30" }), account(), NOW)).toEqual({
      ok: true, fields: { accountId: FTMO, instrumentId: EURUSD.id, direction: "LONG", entryPrice: "1.08500" },
    });
    const body = liveTradeForm({ accountId: FTMO, direction: "LONG" }, "f0000000-0000-4000-8000-000000000001");
    expect(body.has("enteredAt")).toBe(false);
  });

  it("moves an untouched Now to Not sure when the position is already open, and never back to Now", () => {
    // An already open position did not start when the form is saved; a time can never be corrected once recorded.
    expect(withPriceLater(live(), true)).toMatchObject({ priceLater: true, timing: "unknown" });
    expect(withPriceLater(live({ timing: "earlier", enteredAt: "2026-10-23T07:30" }), true)).toMatchObject({ priceLater: true, timing: "earlier", enteredAt: "2026-10-23T07:30" });
    expect(withPriceLater(live({ priceLater: true, timing: "unknown" }), false)).toMatchObject({ priceLater: false, timing: "unknown" });
    expect(withPriceLater(live({ priceLater: true, timing: "now" }), false)).toMatchObject({ priceLater: false, timing: "now" });
    expect(TIMING_LABELS).toEqual({ now: "Now", earlier: "Earlier", unknown: "Not sure" });
    expect(strategyTimeHint("08:56")).toBe("Strategy time (UTC−5), now 08:56.");
  });

  it("checks the contract's tick, size step, minimum and stop side like record_live_trade", () => {
    const errors = validateLive(live({ entryPrice: "1.085005", quantity: "0.015", initialStop: "1.2", riskAmount: "12.345" }), account(), NOW);
    expect(errors).toEqual({
      ok: false,
      fieldErrors: {
        entryPrice: "Prices must align to the EURUSD tick size of 0.00001.", quantity: "Size must be a multiple of the EURUSD size step of 0.01.",
        initialStop: "For a long trade, the stop must be below the entry.", riskAmount: LIVE_FIELD_COPY.riskAmount,
      },
    });
    expect(validateLive(live({ initialStop: "1.08600" }), account(), NOW)).toEqual({ ok: false, fieldErrors: { initialStop: "For a long trade, the stop must be below the entry." } });
    expect(validateLive(live({ quantity: "0.001" }), account({ instruments: [{ ...EURUSD, quantityStep: "0.001", minimumQuantity: "0.01" }] }), NOW))
      .toEqual({ ok: false, fieldErrors: { quantity: "The minimum EURUSD size is 0.01." } });
  });

  it("records an already open position without a price, and another symbol in capitals", () => {
    expect(validateLive(live({ priceLater: true, entryPrice: "junk" }), account(), NOW)).toEqual({ ok: true, fields: { accountId: FTMO, instrumentId: EURUSD.id, direction: "LONG", enteredAt: "now" } });
    const other = validateLive(live({ instrumentId: OTHER_SYMBOL, symbol: "us30 ", entryPrice: "39000.5", direction: "SHORT", entryModel: "OTHER" }), account(), NOW);
    expect(other).toEqual({ ok: true, fields: { accountId: FTMO, symbol: "US30", direction: "SHORT", entryModel: "OTHER", entryPrice: "39000.5", enteredAt: "now" } });
    expect(validateLive(live({ instrumentId: OTHER_SYMBOL, symbol: "" }), account(), NOW)).toMatchObject({ ok: false, fieldErrors: { symbol: LIVE_FIELD_COPY.instrumentId } });
    expect(validateLive(live({ instrumentId: OTHER_SYMBOL, symbol: "bad symbol" }), account(), NOW)).toMatchObject({ ok: false, fieldErrors: { symbol: LIVE_FIELD_COPY.symbol } });
    expect(validateLive(live({ direction: "" }), null, NOW)).toMatchObject({ ok: false, fieldErrors: { accountId: LIVE_FIELD_COPY.accountId, direction: LIVE_FIELD_COPY.direction } });
  });

  it("derives the risk at the stop, keeps the symbol across accounts and posts the request key", () => {
    expect(derivedLiveRisk(live({ quantity: "0.50", initialStop: "1.08350" }), EURUSD)).toBe("$75.00");
    expect(derivedLiveRisk(live({ quantity: "0.50", initialStop: "1.08600" }), EURUSD)).toBeNull();
    expect(switchLiveAccount(live(), demo(), [account(), demo()])).toMatchObject({ accountId: DEMO, instrumentId: DEMO_EURUSD.id });
    expect(switchLiveAccount(live(), account({ id: DEMO, instruments: [GBPUSD] }), [account()])).toMatchObject({ instrumentId: OTHER_SYMBOL, symbol: "EURUSD" });
    expect(newLiveDraft(account({ instruments: [] })).instrumentId).toBe(OTHER_SYMBOL);
    expect(newLiveDraft(account({ instruments: [EURUSD] })).instrumentId).toBe(EURUSD.id);
    const form = liveTradeForm({ accountId: FTMO, enteredAt: "now" }, "f0000000-0000-4000-8000-000000000001");
    expect(Object.fromEntries(form.entries())).toEqual({ accountId: FTMO, enteredAt: "now", requestKey: "f0000000-0000-4000-8000-000000000001" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Screens.
// ---------------------------------------------------------------------------------------------------------------------
describe("Plan Trade screen", () => {
  it("renders the progressive form with the required copy and no raw identifiers", () => {
    const markup = render(planForm({ initial: newPlanDraft(null) }));
    expectClean(markup);
    const text = visibleText(markup);
    for (const words of [
      PLAN_TITLE, "Setup", "Prices and risk", "Thesis", "Checks", "Screenshots", "Trading account", "Instrument", "Choose an account first", "Direction", "Long", "Short", "Model",
      "OB first touch", "OTE", "Entry", "Stop loss", "Target", "Risk per trade", "0.25%", "0.50%", "0.75%", "1.00%", "Custom", "Economic news", "Not checked",
      "Checked · clear", "Restricted window", CONTRACT_LABEL, CONTRADICTION_LABEL, "Risk check preview", "Save draft", "Choose a trading account",
    ]) expect(text).toContain(words);
    expect(markup).toContain(`placeholder="${THESIS_PLACEHOLDER}"`);
    expect(text).toContain("Ticking it blocks the plan from being locked.");
    expect(text).toContain("Choose a trading account to see its risk check.");
    // Save is never disabled for a missing choice: pressing it explains what is missing.
    expect(markup).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("shows an approved preview with size, risk and RR", () => {
    const text = visibleText(render(planForm()));
    expect(text).toContain("Every rule passes. Save the draft, then lock the plan from the trade page.");
    for (const value of ["3.33", "$499.50", "0.50% of equity", "3.33R", "Meets the 3.00R minimum", "15 pips · 150 ticks", "$1,665.00", "$500.00", "2 notes"]) expect(text).toContain(value);
    expect(text).toContain("FTMO 100K · Risk Plan V1.2 · 2 of 2 trades left today · $2,500.00 daily risk left");
    expect(text).toContain("Sized in lots (100,000 EUR).");
    expect(text).toContain("EURUSD: tick size 0.00001 · tick value $1.00 · size in lots (100,000 EUR), step 0.01, minimum 0.01");
  });

  it("offers to confirm unchanged account values when they are from an earlier day", () => {
    const markup = render(planForm({ accounts: [account({ observationDay: "2026-10-22" })] }));
    const text = visibleText(markup);
    expect(text).toContain("Account values need confirming");
    expect(text).toContain("Confirm today's account balance before locking (last recorded Oct 22).");
    expect(text).toContain("Balance $100,000.00 · equity $100,000.00");
    expect(text).toContain("Confirm unchanged");
    expect(markup).toContain(`href="/accounts/${FTMO}/manage?tab=account-values"`);
    expectClean(markup);
  });

  it("says what an account still needs, with the Manage tab that fixes it", () => {
    const markup = render(planForm({ accounts: [account({ risk: null, riskPlanId: null, gaps: ["RISK_PLAN", "INSTRUMENTS"], instruments: [] })], initial: plan({ instrumentId: "" }) }));
    const text = visibleText(markup);
    expect(text).toContain(GAP_COPY.RISK_PLAN.text);
    expect(text).toContain(GAP_COPY.INSTRUMENTS.text);
    expect(markup).toContain(`href="/accounts/${FTMO}/manage?tab=risk-policy"`);
    expect(markup).toContain(`href="/accounts/${FTMO}/manage?tab=instruments"`);
    expect(text).toContain("No instruments yet");
  });

  it("keeps the desktop save inside the preview card, pinned to the window's bottom edge while the card runs past it", () => {
    const markup = render(planForm({ autosaveKey: autosaveKey("scope", { form: "plan" }) }));
    const start = markup.indexOf('id="risk-preview"');
    const card = markup.slice(start, markup.indexOf("</section>", start));
    expect(card).toMatch(/class="sticky bottom-0[^"]*"/);
    expect(card).toMatch(/<button[^>]*type="submit"[^>]*>.*Save draft/);
    expect(visibleText(card)).toContain("Cancel");
    // The phone action bar keeps its own save; the restored-entries notice only appears after mount.
    expect(count(markup, 'type="submit"')).toBe(2);
    expect(visibleText(markup)).not.toContain(RESTORED_TITLE);
  });

  it("stacks each staged screenshot's preview above its label and timeframe on phones", () => {
    const classes = decode(render(planForm()));
    expect(classes).toContain("[&_ul[aria-label='Screenshots_to_save']]:grid-cols-1");
    expect(classes).toContain("max-sm:[&_ul[aria-label='Screenshots_to_save']>li]:flex-col");
    expect(classes).toContain("max-sm:[&_ul[aria-label='Screenshots_to_save']>li>img]:w-full");
  });

  it("blocks a duplicate of today's locked plan in the preview", () => {
    const locked = { instrumentVersionId: EURUSD.id, proposal: { direction: "LONG", model: "OTE", entry: "1.08500", stop: "1.08350", target: "1.09000" } };
    const text = visibleText(render(planForm({ accounts: [account({ todaysPlans: [locked] })] })));
    expect(text).toContain("Duplicate plan");
    expect(text).toContain("An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today.");
    expect(text).toContain("Saving keeps it as a draft. It can't be locked until this is resolved:");
  });
});

const EDIT_MODE = {
  kind: "edit" as const, tradeId: TRADE, title: "EURUSD · Long", revision: 2, expectedRevision: 2, stateLabel: "Blocked", stateTone: "danger" as const, archived: false,
  aiAnalysesOfRevision: 1, contractUpdatedSymbol: null,
};

describe("Edit Draft screen", () => {
  it("shows the revision step, the AI warning, the trade's account and the saved screenshots read-only", () => {
    const evidence = [
      { id: "f1000000-0000-4000-8000-000000000001", name: "M5 chart", tag: "Pre-entry · M5", thumbSrc: "/api/evidence/f1000000-0000-4000-8000-000000000001?variant=thumb", recordedAt: "2026-10-23T12:40:00Z" },
      { id: "f1000000-0000-4000-8000-000000000002", name: "HTF chart", tag: "HTF · H1", thumbSrc: "/api/evidence/f1000000-0000-4000-8000-000000000002?variant=thumb", recordedAt: "2026-10-22T12:40:00Z" },
    ];
    const markup = render(planForm({
      accounts: [account()], mode: EDIT_MODE, evidenceCapacity: 22,
      savedEvidence: createElement(SavedEvidence, { tradeId: TRADE, items: evidence, now: NOW, display: { mode: "strategy" } }),
    }));
    expectClean(markup);
    const text = visibleText(markup);
    expect(text).toContain("Edit draft");
    expect(text).toContain("Revision 2 → 3");
    expect(text).toContain("Blocked");
    expect(text).toContain(`${aiRevisionWarning(2)}.`);
    expect(text).toContain("FTMO 100K · USD");
    expect(text).toContain("A revision keeps the trade's account.");
    expect(text).toContain("Save revision 3");
    expect(text).toContain(savedEvidenceSummary(2));
    expect(text).toContain("Pre-entry · M5 Saved 07:40");
    expect(text).toContain("HTF · H1 Saved Oct 22, 07:40");
    expect(markup).toContain(`href="/trades/${TRADE}#evidence-f1000000-0000-4000-8000-000000000001"`);
    expect(markup).toContain(`href="/trades/${TRADE}#evidence"`);
    // The account can't change in a revision: no account select.
    expect(markup).not.toContain('id="plan-account"');
  });

  it("warns about an archived account and a superseded contract, and hides the AI warning without analyses", () => {
    const text = visibleText(render(planForm({ accounts: [account()], mode: { ...EDIT_MODE, archived: true, contractUpdatedSymbol: "EURUSD", aiAnalysesOfRevision: 0 } })));
    expect(text).toContain("This trading account is archived");
    expect(text).toContain("The EURUSD contract was updated");
    expect(text).not.toContain("existing AI analysis");
    expect(text).toContain("Add more screenshots");
    expect(visibleText(render(createElement(SavedEvidence, { tradeId: TRADE, items: [], now: NOW, display: { mode: "strategy" } })))).toBe("No screenshots are saved with this draft yet.");
  });

  it("explains a trade that can't be edited", () => {
    const markup = render(createElement(NotEditableView, { data: { tradeId: TRADE, title: "XAUUSD · Short", stateLabel: "Locked · waiting for entry", stateTone: "info", reason: LOCKED_PLAN_NOTE } }));
    expectClean(markup);
    const text = visibleText(markup);
    expect(text).toContain(NOT_EDITABLE_TITLE);
    expect(text).toContain(LOCKED_PLAN_NOTE);
    expect(text).toContain("Open the trade");
  });
});

describe("Record Live Trade screen", () => {
  it("renders the minimal form with the account's daily usage and no raw identifiers", () => {
    const markup = render(createElement(LiveTradeForm, { now: NOW, accounts: [account({ usageOverrides: { plannedSlots: 1 } }), demo()], initial: newLiveDraft(account()) }));
    expectClean(markup);
    const text = visibleText(markup);
    for (const words of [LIVE_TITLE, "Trading account", "Instrument", "Other symbol…", "Direction", "Entry price", PRICE_LATER, "Entry time", "Now", "Earlier", "Size, stop and risk", START_LIVE_JOURNAL]) {
      expect(text).toContain(words);
    }
    expect(text).toContain(liveUsageText({ day: DAY, used: 1, planned: 1, unplanned: 0, max: 2 }));
    expect(text).toContain("Live-first trades have no pre-trade plan. Use Plan Trade before entry when you can.");
    expect(text).toContain("Recorded as the moment you save.");
    expect(markup).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("still records at the daily trade limit, saying so", () => {
    const full = account({ usageOverrides: { plannedSlots: 1, unplannedTrades: 1 } });
    const text = visibleText(render(createElement(LiveTradeForm, { now: NOW, accounts: [full], initial: newLiveDraft(full) })));
    expect(text).toContain(limitReachedTitle({ day: DAY, used: 2, planned: 1, unplanned: 1, max: 2 }));
    expect(text).toContain(LIMIT_REACHED_BODY);
  });

  it("shows a strategy-time field for an earlier entry, with the current strategy time, and the derived risk", () => {
    const markup = render(createElement(LiveTradeForm, { now: NOW, accounts: [account()], initial: live({ timing: "earlier", enteredAt: "2026-10-23T07:30", quantity: "0.50", initialStop: "1.08350" }) }));
    const text = visibleText(markup);
    expect(text).toContain("Entry date and time (UTC−5)");
    expect(markup).toContain('max="2026-10-23T08:00"');
    // Phones have no header clock: the hint says what time it is in strategy time.
    expect(text).toContain("Strategy time (UTC−5), now 08:00.");
    expect(text).not.toContain("clock in the header");
    expect(text).toContain("Without it, R uses the risk at your stop: $75.00 (from entry, stop and size).");
  });

  it("offers Now, Earlier and Not sure, and says how an unknown entry time is added later", () => {
    const fresh = visibleText(render(createElement(LiveTradeForm, { now: NOW, accounts: [account()], initial: newLiveDraft(account()) })));
    expect(fresh).toContain("Now Earlier Not sure");
    expect(fresh).toContain(TIMING_NOW_HINT);
    const markup = render(createElement(LiveTradeForm, { now: NOW, accounts: [account()], initial: live({ priceLater: true, timing: "unknown", entryPrice: "" }) }));
    const text = visibleText(markup);
    expect(text).toContain(TIMING_UNKNOWN_HINT);
    expect(text).not.toContain(TIMING_NOW_HINT);
    expect(markup).toMatch(/<input type="radio" name="timing" checked="" value="unknown"\/>/);
    expect(markup).toContain('aria-describedby="live-time-hint"');
    expectClean(markup);
  });

  it("renders no restored-entries notice on the server (entries come back after mount, so hydration matches)", () => {
    const markup = render(createElement(LiveTradeForm, { now: NOW, accounts: [account()], initial: newLiveDraft(account()), autosaveKey: autosaveKey("scope", { form: "live" }) }));
    expect(visibleText(markup)).not.toContain(RESTORED_TITLE);
  });

  it("says when an account's data could not be read", () => {
    const broken = account({ gaps: ["UNAVAILABLE"], instruments: [], risk: null, usage: null });
    const text = visibleText(render(createElement(LiveTradeForm, { now: NOW, accounts: [broken], initial: newLiveDraft(broken) })));
    expect(text).toContain(GAP_COPY.UNAVAILABLE.text);
  });
});

describe("no trading account", () => {
  it("explains that every trade belongs to an account and offers to create or restore one", () => {
    const markup = render(createElement(NoTradingAccount, { kind: "plan", hasArchived: true }));
    expectClean(markup);
    const text = visibleText(markup);
    expect(text).toContain(NO_ACCOUNT_TITLE);
    expect(text).toContain(noAccountDescription("plan", true));
    expect(text).toContain("Create trading account");
    expect(text).toContain("Open Accounts");
    expect(visibleText(render(createElement(NoTradingAccount, { kind: "live", hasArchived: false })))).not.toContain("Open Accounts");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard (spec §13.4): Ctrl/⌘+Enter submits; a plain Enter never does.
// ---------------------------------------------------------------------------------------------------------------------
describe("keyboard", () => {
  class FakeInput {
    constructor(readonly type: string) {}
  }

  function press(target: unknown, keys: { key?: string; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean } = {}) {
    const preventDefault = vi.fn();
    const requestSubmit = vi.fn();
    const event = {
      key: keys.key ?? "Enter", ctrlKey: keys.ctrlKey ?? false, metaKey: keys.metaKey ?? false, shiftKey: false, altKey: false,
      nativeEvent: { isComposing: keys.isComposing ?? false }, target, currentTarget: { closest: () => ({ requestSubmit }) }, preventDefault,
    };
    formKeyDown(event as unknown as KeyboardEvent<HTMLFormElement>);
    return { prevented: preventDefault.mock.calls.length > 0, submitted: requestSubmit.mock.calls.length > 0 };
  }

  beforeEach(() => vi.stubGlobal("HTMLInputElement", FakeInput));
  afterEach(() => vi.unstubAllGlobals());

  it("never submits on a plain Enter in a field or on a checkbox, radio or chip", () => {
    for (const type of ["checkbox", "radio", "text", "datetime-local", "number", "search"]) expect(blocksPlainEnter(type)).toBe(true);
    for (const type of ["submit", "button", "reset", "image", "file", "color", "SUBMIT"]) expect(blocksPlainEnter(type)).toBe(false);
    // The contract checkbox after "Confirm contract", a direction radio, a risk or news chip, Now/Earlier/Not sure.
    for (const type of ["checkbox", "radio", "text", "datetime-local"]) expect(press(new FakeInput(type))).toEqual({ prevented: true, submitted: false });
  });

  it("leaves buttons, links and other elements their own Enter, and submits on Ctrl/⌘+Enter", () => {
    expect(press(new FakeInput("submit"))).toEqual({ prevented: false, submitted: false });
    expect(press({ tagName: "BUTTON" })).toEqual({ prevented: false, submitted: false });
    expect(press(new FakeInput("checkbox"), { ctrlKey: true })).toEqual({ prevented: true, submitted: true });
    expect(press(new FakeInput("radio"), { metaKey: true })).toEqual({ prevented: true, submitted: true });
    expect(press(new FakeInput("checkbox"), { isComposing: true })).toEqual({ prevented: false, submitted: false });
    expect(press(new FakeInput("checkbox"), { key: " " })).toEqual({ prevented: false, submitted: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Unsaved entries kept in the tab (Back, swipe-back, reload).
// ---------------------------------------------------------------------------------------------------------------------
class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

describe("unsaved entries kept in the tab", () => {
  const REQUEST_KEY = "f0000000-0000-4000-8000-000000000001";
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keys each form per user and per draft revision, without raw ids", () => {
    const user = "c0000000-0000-4000-8000-000000000001";
    const scope = autosaveScope(user);
    expect(scope).toBe(autosaveScope(" C0000000-0000-4000-8000-000000000001 "));
    expect(scope).not.toBe(autosaveScope("c0000000-0000-4000-8000-000000000002"));
    const edit = autosaveKey(scope, { form: "edit", tradeId: TRADE, revision: 2 });
    expect(autosaveKey(scope, { form: "plan" })).toBe(`tos.form.${scope}.plan.new`);
    expect(autosaveKey(scope, { form: "live" })).toBe(`tos.form.${scope}.live.new`);
    expect(edit).toMatch(new RegExp(`^tos\\.form\\.${scope}\\.edit-[0-9a-z]+\\.r2$`));
    expect(autosaveKey(scope, { form: "edit", tradeId: TRADE, revision: 3 })).not.toBe(edit);
    for (const key of [scope, edit]) {
      expect(key).not.toMatch(UUID);
      expect(key).not.toContain(user);
    }
  });

  it("keeps the entries with the request key and drops unreadable ones", () => {
    const key = autosaveKey("scope", { form: "plan" });
    writeAutosave(key, { draft: plan(), requestKey: REQUEST_KEY });
    expect(readAutosave(key)).toEqual({ draft: plan(), requestKey: REQUEST_KEY });
    removeAutosave(key);
    expect(readAutosave(key)).toBeNull();
    for (const text of ["{not json", JSON.stringify({ v: 1, draft: plan(), requestKey: "not-a-key" }), JSON.stringify({ v: 9, draft: plan(), requestKey: null })]) {
      storage.setItem(key, text);
      expect(readAutosave(key)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it("works without storage (private windows, blocked site data)", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => writeAutosave("tos.form.scope.plan.new", { draft: plan(), requestKey: null })).not.toThrow();
    expect(readAutosave("tos.form.scope.plan.new")).toBeNull();
    expect(() => pruneAutosaves("tos.form.scope.plan.new")).not.toThrow();
    expect(() => clearFormAutosaves()).not.toThrow();
  });

  it("removes other users' entries and older revisions of the same draft when a form opens", () => {
    const mine = autosaveScope("me");
    const theirs = autosaveScope("them");
    const current = autosaveKey(mine, { form: "edit", tradeId: TRADE, revision: 3 });
    const kept = [current, autosaveKey(mine, { form: "plan" }), autosaveKey(mine, { form: "edit", tradeId: "d1000000-0000-4000-8000-000000000002", revision: 1 }), "tos.palette.recent.x"];
    const dropped = [autosaveKey(mine, { form: "edit", tradeId: TRADE, revision: 2 }), autosaveKey(theirs, { form: "plan" }), autosaveKey(theirs, { form: "live" })];
    for (const key of [...kept, ...dropped]) storage.setItem(key, "{}");
    pruneAutosaves(current);
    expect(kept.filter(key => storage.getItem(key) === null)).toEqual([]);
    expect(dropped.filter(key => storage.getItem(key) !== null)).toEqual([]);
    clearFormAutosaves();
    expect(storage.length).toBe(1);
    expect(storage.getItem("tos.palette.recent.x")).toBe("{}");
  });

  it("restores plan entries checked against today's accounts", () => {
    const accounts = [account(), demo()];
    expect(restorePlanDraft(plan(), accounts, newPlanDraft(account()))).toEqual(plan());
    expect(restorePlanDraft({ ...plan(), injected: "<b>" }, accounts, newPlanDraft(account()))).toEqual(plan());
    for (const bad of [null, "plan", { ...plan(), direction: "UP" }, { ...plan(), narrative: "x".repeat(5001) }, { ...plan(), contractConfirmed: "yes" }]) {
      expect(restorePlanDraft(bad, accounts, newPlanDraft(account()))).toBeNull();
    }
    // A contract whose version changed is not restored, and must be confirmed again.
    expect(restorePlanDraft(plan({ instrumentId: "e1000000-0000-4000-8000-0000000000aa" }), accounts, newPlanDraft(account()))).toMatchObject({ instrumentId: "", contractConfirmed: false, entry: "1.08500" });
    // A preset above today's maximum falls back to today's default.
    const base = account().riskPlan;
    if (!base) throw new Error("fixture without a risk plan");
    const lowMax = account({ riskPlan: { ...base, maxRiskPercent: "0.5", defaultRiskPercent: "0.25" } });
    expect(restorePlanDraft(plan({ riskChoice: "1" }), [lowMax], newPlanDraft(lowMax))).toMatchObject({ riskChoice: "0.25", customRisk: "" });
    expect(restorePlanDraft(plan({ riskChoice: CUSTOM_RISK, customRisk: "2" }), [lowMax], newPlanDraft(lowMax))).toMatchObject({ riskChoice: CUSTOM_RISK, customRisk: "2" });
  });

  it("moves plan entries of an account that is gone to the page's account, keeping the thesis", () => {
    const gone = plan({ accountId: "a1000000-0000-4000-8000-0000000000ff" });
    expect(restorePlanDraft(gone, [account(), demo()], newPlanDraft(demo()))).toMatchObject({
      accountId: DEMO, instrumentId: DEMO_EURUSD.id, contractConfirmed: false, narrative: plan().narrative, entry: "1.08500",
    });
    expect(restorePlanDraft(gone, [account(), demo()], newPlanDraft(null))).toMatchObject({ accountId: "", instrumentId: "", contractConfirmed: false, narrative: plan().narrative });
  });

  it("restores live entries checked against today's accounts", () => {
    const accounts = [account(), demo()];
    const unsure = live({ priceLater: true, timing: "unknown", entryPrice: "" });
    expect(restoreLiveDraft(unsure, accounts, newLiveDraft(account()))).toEqual(unsure);
    expect(restoreLiveDraft(live({ instrumentId: OTHER_SYMBOL, symbol: "US30" }), accounts, newLiveDraft(account()))).toMatchObject({ instrumentId: OTHER_SYMBOL, symbol: "US30" });
    expect(restoreLiveDraft(live({ instrumentId: GBPUSD.id }), [demo()], newLiveDraft(demo()))).toMatchObject({ accountId: DEMO, instrumentId: DEMO_EURUSD.id, entryPrice: "1.08500" });
    expect(restoreLiveDraft(live({ accountId: DEMO, instrumentId: GBPUSD.id }), accounts, newLiveDraft(account()))).toMatchObject({ accountId: DEMO, instrumentId: "" });
    expect(restoreLiveDraft({ ...live(), timing: "later" }, accounts, newLiveDraft(account()))).toBeNull();
    expect(restoreLiveDraft({ ...live(), symbol: "X".repeat(21) }, accounts, newLiveDraft(account()))).toBeNull();
  });

  it("brings back only changed, valid entries, with their request key", () => {
    const accounts = [account(), demo()];
    const opened = newPlanDraft(account());
    const restore = (stored: unknown) => restorePlanDraft(stored, accounts, opened);
    expect(restorableEntries(null, restore, opened)).toBeNull();
    expect(restorableEntries({ draft: opened, requestKey: null }, restore, opened)).toBeNull();
    expect(restorableEntries({ draft: { ...plan(), direction: "UP" }, requestKey: REQUEST_KEY }, restore, opened)).toBeNull();
    // A retry after a lost response stays a replay of the same submission.
    expect(restorableEntries({ draft: plan(), requestKey: REQUEST_KEY }, restore, opened)).toEqual({ draft: plan(), requestKey: REQUEST_KEY });
  });

  it("keeps nothing for untouched entries, and the entries with the key once they change", () => {
    const opened = newLiveDraft(account());
    expect(entriesToKeep(opened, { ...opened }, REQUEST_KEY)).toBeNull();
    expect(entriesToKeep(live(), opened, null)).toEqual({ draft: live(), requestKey: null });
    expect(entriesToKeep(live(), opened, REQUEST_KEY)).toEqual({ draft: live(), requestKey: REQUEST_KEY });
  });

  it("compares drafts by value, whatever the key order", () => {
    const reordered = Object.fromEntries(Object.entries(plan()).reverse()) as PlanDraft;
    expect(sameDraft(plan(), reordered)).toBe(true);
    expect(sameDraft(plan(), plan({ entry: "1.08501" }))).toBe(false);
    expect(sameDraft(plan(), { ...plan(), extra: true } as PlanDraft)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pages.
// ---------------------------------------------------------------------------------------------------------------------
describe("pages", () => {
  const formData = (accounts: FormAccount[], defaultAccountId: string | null) => ({ now: NOW, accounts, defaultAccountId, hasArchived: false, autosaveScope: "scope" });

  it("Plan Trade preselects the default account (spec §9.2) or explains there is none", async () => {
    m.formData.mockResolvedValue(formData([account(), demo()], DEMO));
    const markup = render(await PlanTradePage());
    expectClean(markup);
    expect(visibleText(markup)).toContain("Demo 100K · USD");
    expect(markup).toMatch(new RegExp(`<option value="${DEMO}" selected=""`));
    m.formData.mockResolvedValue(formData([], null));
    expect(visibleText(render(await PlanTradePage()))).toContain(NO_ACCOUNT_TITLE);
  });

  it("Record Live Trade preselects the default account or explains there is none", async () => {
    m.formData.mockResolvedValue(formData([account()], FTMO));
    const markup = render(await RecordLiveTradePage());
    expectClean(markup);
    expect(markup).toMatch(new RegExp(`<option value="${FTMO}" selected=""`));
    m.formData.mockResolvedValue(formData([], null));
    expect(visibleText(render(await RecordLiveTradePage()))).toContain(NO_ACCOUNT_TITLE);
  });

  it("Edit Draft answers 404 for a foreign trade, explains a locked one and prefills a draft", async () => {
    const params = Promise.resolve({ id: TRADE });
    m.editDraft.mockResolvedValue(null);
    expect(await digestOf(() => EditDraftPage({ params }))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    m.editDraft.mockResolvedValue({ kind: "not-editable", data: { tradeId: TRADE, title: "XAUUSD · Short", stateLabel: "Locked · waiting for entry", stateTone: "info", reason: LOCKED_PLAN_NOTE } });
    expect(visibleText(render(await EditDraftPage({ params })))).toContain(LOCKED_PLAN_NOTE);
    const data: EditDraftData = {
      now: NOW, tradeId: TRADE, title: "EURUSD · Long", revision: 3, expectedRevision: 3, stateLabel: "Draft", stateTone: "neutral", account: account(), archived: false,
      prefill: { instrumentId: EURUSD.id, direction: "LONG", model: "OTE", entry: "1.08500", stop: "1.08350", target: "1.09000", riskPercent: "0.5", narrative: "Thesis", contractConfirmed: true, news: "CLEAR", contradiction: false },
      contractUpdated: null, evidence: [], evidenceCapacity: 24, aiAnalysesOfRevision: 0, autosaveScope: "scope",
    };
    m.editDraft.mockResolvedValue({ kind: "draft", data });
    const markup = render(await EditDraftPage({ params }));
    expectClean(markup);
    const text = visibleText(markup);
    expect(text).toContain("Revision 3 → 4");
    expect(text).toContain("Save revision 4");
    expect(markup).toContain('value="1.08500"');
    expect(markup).toContain(">Thesis</textarea>");
  });

  it("titles Edit Draft with the trade", async () => {
    m.detail.mockResolvedValue({ title: "EURUSD · Long" });
    expect(await editMetadata({ params: Promise.resolve({ id: TRADE }) })).toEqual({ title: "Edit draft · EURUSD · Long · Trading OS" });
    m.detail.mockResolvedValue(null);
    expect(await editMetadata({ params: Promise.resolve({ id: TRADE }) })).toEqual({ title: "Edit draft · Trading OS" });
  });
});

describe("legacy routes (spec §1.2)", () => {
  it("/analyze opens Plan Trade with its query string", async () => {
    expect(await digestOf(() => LegacyAnalyzePage({ searchParams: Promise.resolve({ account: FTMO }) }))).toBe(`NEXT_REDIRECT;replace;/trades/new?account=${FTMO};307;`);
    expect(await digestOf(() => LegacyAnalyzePage({ searchParams: Promise.resolve({}) }))).toBe("NEXT_REDIRECT;replace;/trades/new;307;");
  });

  it("/analyze/[proposal] opens the trade owning it, 404 when it is not the user's", async () => {
    const params = Promise.resolve({ id: "b1000000-0000-4000-8000-0000000000ff" });
    m.legacy.mockResolvedValue({ kind: "trade", tradeId: TRADE });
    expect(await digestOf(() => LegacySetupPage({ params }))).toBe(`NEXT_REDIRECT;replace;/trades/${TRADE};307;`);
    expect(m.legacy).toHaveBeenCalledWith("b1000000-0000-4000-8000-0000000000ff");
    m.legacy.mockResolvedValue({ kind: "not-found" });
    expect(await digestOf(() => LegacySetupPage({ params }))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    m.legacy.mockResolvedValue({ kind: "schema-outdated" });
    expect(await digestOf(() => LegacySetupPage({ params }))).toBe("NEXT_REDIRECT;replace;/today;307;");
  });

  it("/analyze/[proposal] that can't be opened shows the way back into the app, not a bare 404", async () => {
    const markup = render(await LegacySetupNotFound());
    expectClean(markup);
    const text = visibleText(markup);
    expect(text).toContain(LEGACY_LINK_TITLE);
    expect(text).toContain(LEGACY_LINK_DESCRIPTION);
    expect(text).toContain("Go to Today");
    expect(text).toContain("Open the Journal");
    expect(markup).toContain('href="/today"');
    expect(markup).toContain('href="/journal"');
    // Never says whether the plan exists for someone else.
    expect(text).toContain("The plan may not exist, or it belongs to someone else.");
  });

  it("/preview opens sign-in", async () => {
    expect(await digestOf(() => LegacyPreviewPage())).toBe("NEXT_REDIRECT;replace;/login;307;");
  });
});
