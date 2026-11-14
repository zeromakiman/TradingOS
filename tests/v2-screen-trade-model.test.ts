import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Trade workspace logic (docs/V2_ARCHITECTURE.md §2.3–2.5, §3.4–3.8, §5.1, §8.1–8.5, §14.4): the pure view model, the
// client checks of the page's forms (they reject what the actions and the database would), wall-clock times in the
// person's display, the forms' first render, and the server extras loader with its reads mocked.

const m = vi.hoisted(() => ({
  workspace: null as unknown,
  workspaceError: null as Error | null,
  rows: {} as Record<string, unknown>,
  lists: {} as Record<string, unknown[]>,
  failures: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/trades", () => ({
  recordEntry: vi.fn(), closePlannedTrade: vi.fn(), closeLiveTrade: vi.fn(), completeLiveEntry: vi.fn(), setTags: vi.fn(), setDisposition: vi.fn(),
  completeReview: vi.fn(), reopenReview: vi.fn(), discardDraft: vi.fn(), duplicateDraft: vi.fn(), lockPlan: vi.fn(), checkRisk: vi.fn(),
}));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: (event: string) => m.failures.push(event) }));
vi.mock("@/lib/account-context", () => ({
  currentSession: async () => ({
    user: { id: "10000000-0000-4000-8000-000000000001" },
    db: {
      from: (table: string) => {
        // One row (`maybeSingle`) or, when the query itself is awaited, the table's list.
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          maybeSingle: async () => ({ data: m.rows[table] ?? null, error: null }),
          // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
          then: (resolve: (value: unknown) => unknown) => resolve({ data: m.lists[table] ?? [], error: null }),
        };
        return chain;
      },
    },
  }),
}));
vi.mock("@/lib/workspace", () => ({
  RISK_PLAN_SELECT: "id",
  getAccountWorkspace: async () => {
    if (m.workspaceError) throw m.workspaceError;
    return m.workspace;
  },
  parseRiskPlanRow: (row: { id: string; version: string }) => ({
    id: row.id, version: row.version, maxRiskPercent: "0.75", defaultRiskPercent: "0.5", minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", maxDailyTrades: 2,
    dailyRiskCap: "2000", dailyLossCap: null,
  }),
}));

import { labelOptionsForDefault } from "@/components/evidence/labels";
import { CloseTradeForm } from "@/components/trade/close-trade-form";
import { skipDialogCopy } from "@/components/trade/copy";
import { EntryDetailsForm } from "@/components/trade/entry-details-form";
import {
  addTags, closeFieldOf, EMPTY_DETAILS, FORM_COPY, isAligned, MAX_TAGS, normalizeTag, oversizeWarning, resolveTime, sameTags, signedPnl, validateClose,
  validateEntry, validateEntryDetails,
} from "@/components/trade/form-model";
import {
  ARCHIVED_DRAFT_HINT, addedLater, type BlockingCheck, blockedOnEarlierDay, blockingCheckOf, blockingNow, closeMode, draftSource, duplicateNotes, entryDefaults, entryLine,
  evidenceMode, headerActions, headerFacts, lastRevisionSource, lessonsOf, lessonTiming, listInWords, liveStopMove, lockBlockedReason, lockedLine, lockedSource,
  lockSummary, missingEntryFields, newEntriesLabel, nextStepHint, outcomeView, type PlanSource, pageState, planChecks, planFacts, positionFacts, positionRecordedLine,
  resultSummary, reviewMode, riskBasisPreview, skipSlotNote, whenLabel, workspaceLayout,
} from "@/components/trade/model";
import { RecordEntryForm } from "@/components/trade/record-entry-form";
import { returnFocusTo, reveal, revealTradeTarget, TRADE_TARGETS, tradeTargetOf } from "@/components/trade/reveal";
import { TagsForm } from "@/components/trade/tags-form";
import { instantOfWallClock, wallClockOf, zoneHint } from "@/components/trade/time-input";
import { TradeProgress } from "@/components/trade/trade-progress";
import { loadTradeExtras } from "@/components/trade/workspace-data";
import { previewContext, previewProposal, usageFixture } from "@/domain/fixtures";
import { LEDGER_COLUMNS, LIFECYCLES, type LedgerTrade, type Lifecycle } from "@/domain/ledger";
import { planVsReality } from "@/domain/plan-vs-reality";
import { type DailyUsage, evaluateRisk, type RiskContext } from "@/domain/risk";
import { explainReport } from "@/domain/risk-explain";
import type { RiskReportV12 } from "@/domain/risk-report";
import { STRATEGY_TIME } from "@/domain/time-display";
import type { TimelineItem, TimelineKind, Timing } from "@/domain/timeline";
import { blockingFindingsOf, deriveTradeState, planEndedAt } from "@/domain/trade-state";
import type { CheckView, EvidenceItemView, ProposalView, TradeDetail } from "@/lib/trades-data";

const NOW = "2026-10-23T19:00:00.000Z"; // Fri Oct 23, 14:00 UTC−5
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const EURUSD = { symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 units)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" };

function ledger(changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: uuid(1), account_id: ACCOUNT, origin: "PLANNED", created_at: "2026-10-23T12:00:00Z", currency: "USD", revision_count: 1, latest_revision: 1,
    latest_proposal_id: uuid(2), entry_time_known: false, lifecycle: "DRAFT", draft_check: "UNCHECKED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0,
    symbol: "EURUSD", instrument_version_id: uuid(3), direction: "LONG", entry_model: "OB_FIRST_TOUCH", planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106",
    requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "500", ...changes,
  };
}

const PROPOSAL: ProposalView = {
  instrumentVersionId: uuid(3), direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.1", stop: "1.098", target: "1.106", riskPercent: "0.5", narrative: "Sweep, MSS, OB.",
  contractConfirmed: true, news: "CLEAR", contradiction: false,
};

function checkView(decision: "APPROVED" | "BLOCKED", plannedRR = "2.995"): CheckView {
  return {
    recordedAt: "2026-10-23T18:58:00Z", decision, revision: 1, statusLine: "",
    explained: { decision, blocking: decision === "BLOCKED" ? [{ code: "RISK_LIMIT", severity: "BLOCK", title: "Requested risk exceeds maximum", detail: "Requested risk 1.25% exceeds your configured maximum of 0.75%." }] : [], warnings: [], notes: [] },
    calculations: { quantity: "0.25", nominalRisk: "500", plannedRR, budget: "500", stopDistance: "0.002" },
  };
}

/** Fri Oct 23, 09:00 UTC−5: a check in the kill zone of the page's trading day (NOW, 14:00 UTC−5, is in Dead Pool). */
const CHECKED = "2026-10-23T14:00:00Z";
/** The preview account on the page's trading day: equity 10,000, maximum 0.5%, minimum 3R, 2 trades a day, no caps; EURUSD. */
const ENGINE: RiskContext = { ...previewContext, now: CHECKED, observationDay: "2026-10-23", usage: usageFixture({ day: "2026-10-23" }) };

/**
 * The real engine's report 1.2 for a plan (0.5% of 10,000 = a $50 budget: 0.25 lots × 200 ticks × 1), and its check as
 * the trade detail shows it (revision 2, checked at CHECKED).
 */
function engineCheck(proposal: Record<string, unknown> = {}, plan: Partial<RiskContext["plan"]> = {}, usage: Partial<DailyUsage> = {}, changes: Partial<RiskContext> = {}) {
  const ctx: RiskContext = { ...ENGINE, ...changes, plan: { ...ENGINE.plan, ...plan }, usage: usageFixture({ day: "2026-10-23", ...usage }) };
  const report = evaluateRisk({ ...previewProposal, narrative: "Sweep, MSS, OB.", contractConfirmed: true, news: "CLEAR", ...proposal }, ctx);
  const calc = report.calculations;
  const check: CheckView = {
    recordedAt: CHECKED, decision: report.decision, revision: 2, explained: explainReport(report), statusLine: "",
    calculations: calc ? { quantity: calc.quantity, nominalRisk: calc.nominalRisk, plannedRR: calc.plannedRR, budget: calc.budget, stopDistance: calc.stopDistance } : null,
  };
  return { report, check, ctx };
}

/** The detail with `report` stored as its latest check's (Technical details keep every check's report). */
function withReport(base: TradeDetail, report: RiskReportV12): TradeDetail {
  return { ...base, technical: { ...base.technical, latestCheckEvaluationId: uuid(80), checks: [{ evaluationId: uuid(80), recordedAt: CHECKED, report }] } };
}

interface DetailOptions {
  checkCurrent?: boolean;
  aiAvailable?: boolean;
  check?: CheckView | null;
  instrument?: TradeDetail["instrument"];
  close?: Partial<NonNullable<TradeDetail["close"]>>;
  timeline?: TimelineItem[];
  evidenceActive?: number;
  evidenceItems?: EvidenceItemView[];
  disposition?: TradeDetail["disposition"];
  /** The trade's account is archived (§3.2, §9). */
  archived?: boolean;
}

function detail(trade: LedgerTrade, options: DetailOptions = {}): TradeDetail {
  const instrument = options.instrument === undefined ? EURUSD : options.instrument;
  const check = options.check ?? null;
  const state = deriveTradeState(trade, {
    now: NOW, checkCurrent: options.checkCurrent ?? false, aiAvailable: options.aiAvailable ?? false,
    blockingReason: check?.decision === "BLOCKED" ? check.explained.blocking[0]?.detail : undefined, accountArchived: options.archived === true,
  });
  const planned = trade.origin === "PLANNED";
  return {
    tradeId: trade.id, href: `/trades/${trade.id}`, account: { id: ACCOUNT, name: "FTMO 100K", currency: trade.currency, status: options.archived ? "ARCHIVED" : "ACTIVE" },
    origin: trade.origin,
    title: "EURUSD · Long", symbol: trade.symbol, direction: trade.direction, model: trade.entry_model, createdAt: trade.created_at, duplicatedFromHref: null, state,
    revisionCount: trade.revision_count,
    draft: state.lifecycle === "DRAFT" ? { revision: 2, expectedRevision: 2, createdAt: "2026-10-23T18:30:00Z", proposal: PROPOSAL, latestCheck: check, checkCurrent: state.checkCurrent } : null,
    plan: trade.plan_id && trade.locked_at
      ? { lockedAt: trade.locked_at, tradingDay: "2026-10-23", riskPlanVersion: "Risk Plan V1.1", strategyVersion: "ICT V1.0", proposal: PROPOSAL, check: checkView("APPROVED"), nominalRisk: "500", immutableNote: "" }
      : null,
    execution: !planned || trade.entry_recorded_at
      ? { entryPrice: trade.entry_price, enteredAt: trade.entered_at, recordedAt: trade.entry_recorded_at, quantity: trade.quantity, plannedQuantity: trade.planned_quantity, oversize: trade.oversize === true, initialStop: trade.initial_stop, initialRisk: trade.initial_risk, actualRisk: trade.actual_initial_risk }
      : null,
    close: trade.exited_at
      ? {
        exitPrice: trade.exit_price, exitedAt: trade.exited_at, recordedAt: trade.close_recorded_at, fees: trade.fees, grossPnl: trade.gross_pnl, netPnl: trade.net_pnl, realizedR: trade.realized_r,
        outcome: trade.outcome, pnlSource: trade.pnl_source, riskBasisSource: null,
        basisLabel: trade.realized_r === null ? "No risk was recorded, so realized R is not available." : planned ? "R based on locked risk" : "R based on risk recorded after entry",
        ...options.close,
      }
      : null,
    disposition: options.disposition ?? null, planEndedAt: planEndedAt(trade, { dispositionAt: options.disposition?.recordedAt ?? null }),
    planVsReality: planVsReality(trade, instrument), positionFacts: [], instrument,
    tags: { grade: null, liquidity: null, mss: null, tags: [], source: null }, checks: check ? [check] : [], timeline: options.timeline ?? [], timelineGroups: [], timelineTruncated: false,
    evidence: {
      items: options.evidenceItems ?? [], groups: [], limit: 24,
      activeCount: options.evidenceActive ?? (options.evidenceItems ?? []).filter(item => item.removedAt === null).length,
    },
    evidenceIndex: {}, review: { completedAt: trade.review_completed_at },
    ai: { activity: { reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null }, history: null, available: options.aiAvailable ?? false },
    technical: {
      tradeId: trade.id, accountId: ACCOUNT, origin: trade.origin, planId: trade.plan_id, latestProposalId: trade.latest_proposal_id, proposalIds: [], latestCheckEvaluationId: null,
      strategyVersionId: trade.strategy_version_id, riskPlanVersionId: trade.risk_plan_version_id, instrumentVersionId: trade.instrument_version_id, duplicatedFrom: null,
      migratedFrom: null, checks: [], planReport: null, evidence: [], ledger: trade,
    },
  };
}

const LOCKED: Partial<LedgerTrade> = { plan_id: uuid(10), locked_at: "2026-10-23T07:52:00Z", draft_check: null, strategy_version_id: uuid(11), risk_plan_version_id: uuid(12) };
const LIVE: Partial<LedgerTrade> = { ...LOCKED, lifecycle: "LIVE", entered_at: "2026-10-23T08:05:00Z", entry_recorded_at: "2026-10-23T08:06:00Z", entry_price: "1.1", quantity: "0.25", initial_risk: "500", actual_initial_risk: "500" };
const CLOSED: Partial<LedgerTrade> = {
  ...LIVE, lifecycle: "CLOSED", exit_price: "1.10612", exited_at: "2026-10-23T10:50:00Z", close_recorded_at: "2026-10-23T18:44:00Z", fees: "7", gross_pnl: "1537", net_pnl: "1530",
  realized_r: "3.06", outcome: "WIN", pnl_source: "CALCULATED",
};
const LIVE_FIRST: Partial<LedgerTrade> = {
  origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_proposal_id: null, lifecycle: "LIVE", draft_check: null, planned_entry: null, planned_stop: null,
  planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null, entered_at: "2026-10-23T18:05:00Z", created_at: "2026-10-23T18:10:00Z",
};

// ---------------------------------------------------------------------------------------------------------------------
// Layout and actions
// ---------------------------------------------------------------------------------------------------------------------
describe("workspace layout (§14.4)", () => {
  const layoutOf = (lifecycle: Lifecycle, origin: "PLANNED" | "LIVE_FIRST" = "PLANNED") => workspaceLayout({ origin, state: { lifecycle } });

  it("orders the main sections by lifecycle and leaves the plan out of trades without one", () => {
    expect(layoutOf("DRAFT").main).toEqual(["plan", "review"]);
    expect(layoutOf("LOCKED").main).toEqual(["plan", "execution", "review"]);
    expect(layoutOf("LIVE").main).toEqual(["plan", "execution", "result", "review"]);
    expect(layoutOf("CLOSED").main).toEqual(["plan", "execution", "result", "review"]);
    expect(layoutOf("SKIPPED").main).toEqual(["plan", "review"]);
    expect(layoutOf("DISCARDED").main).toEqual(["plan"]);
    expect(layoutOf("LIVE", "LIVE_FIRST").main).toEqual(["execution", "result", "review"]);
    expect(layoutOf("REVIEWED", "LIVE_FIRST").main).toEqual(["execution", "result", "review"]);
  });

  it("leads with the journal only while live, and docks the composer then", () => {
    expect(layoutOf("LIVE").blocks).toEqual(["journal", "main", "evidence"]);
    expect(layoutOf("LIVE").stickyComposer).toBe(true);
    expect(layoutOf("CLOSED").blocks).toEqual(["main", "journal", "evidence"]);
    expect(layoutOf("DRAFT").blocks).toEqual(["main", "evidence", "journal"]);
    expect(LIFECYCLES.filter(lifecycle => layoutOf(lifecycle).stickyComposer)).toEqual(["LIVE"]);
  });

  it("reviews closed trades, reflects on plans not taken and tags open trades", () => {
    expect(LIFECYCLES.map(lifecycle => [lifecycle, reviewMode(lifecycle)])).toEqual([
      ["DRAFT", "tags"], ["LOCKED", "tags"], ["LIVE", "tags"], ["CLOSED", "review"], ["REVIEWED", "review"], ["SKIPPED", "reflection"], ["CANCELLED", "reflection"],
      ["DISCARDED", null],
    ]);
  });
});

describe("header actions (§2.4)", () => {
  it("has one primary action per state and keeps paid AI out of the header", () => {
    const primaryOf = (trade: LedgerTrade, options: DetailOptions = {}) => headerActions(detail(trade, options).state).primary?.label ?? null;
    expect(primaryOf(ledger())).toBe("Check risk (free)");
    expect(primaryOf(ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "BLOCKED" }), { check: checkView("BLOCKED") })).toBe("Edit draft");
    expect(primaryOf(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { checkCurrent: true, aiAvailable: true })).toBe("Lock plan");
    expect(primaryOf(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }))).toBe("Recheck risk");
    expect(primaryOf(ledger({ ...LOCKED, lifecycle: "LOCKED" }))).toBe("Record entry");
    expect(primaryOf(ledger(LIVE))).toBe("Add to journal");
    expect(primaryOf(ledger(CLOSED), { aiAvailable: true })).toBe("Write review");
    expect(primaryOf(ledger({ ...CLOSED, lifecycle: "REVIEWED", review_completed_at: "2026-10-23T18:50:00Z" }))).toBeNull();
    const ready = headerActions(detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { checkCurrent: true, aiAvailable: true }).state);
    expect(ready.secondary.map(action => action.label)).toEqual(["Edit draft"]);
  });

  it("puts Duplicate, Discard, Skip and Technical details in the menu, and the visible secondary actions there for phones", () => {
    const draftMenu = headerActions(detail(ledger()).state).menu;
    expect(draftMenu.map(entry => [entry.kind, entry.compactOnly ?? false])).toEqual([["EDIT_DRAFT", true], ["DUPLICATE", false], ["DISCARD", false], ["DELETE", false], ["TECHNICAL", false]]);
    expect(draftMenu.find(entry => entry.kind === "DISCARD")).toMatchObject({ label: "Discard draft", destructive: true });
    expect(headerActions(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" })).state).menu.map(entry => entry.kind)).toEqual(["DUPLICATE", "SKIP", "DELETE", "TECHNICAL"]);
    expect(headerActions(detail(ledger(LIVE)).state).menu.map(entry => entry.kind)).toEqual(["CLOSE_TRADE", "DUPLICATE", "DELETE", "TECHNICAL"]);
    const reviewed = headerActions(detail(ledger({ ...CLOSED, lifecycle: "REVIEWED", review_completed_at: "2026-10-23T18:50:00Z" })).state);
    expect(reviewed.secondary.map(action => action.label)).toEqual(["Reopen review"]);
    expect(reviewed.menu.map(entry => entry.kind)).toEqual(["DUPLICATE", "DELETE", "TECHNICAL"]);
    expect(headerActions(detail(ledger({ ...LIVE_FIRST, entry_model: null })).state).menu.map(entry => entry.kind)).toEqual(["ADD_ENTRY_DETAILS", "CLOSE_TRADE", "DELETE", "TECHNICAL"]);
    // Delete trade (0020) is listed on a locked or live trade but unavailable, with the reason; a trashed trade offers nothing.
    expect(headerActions(detail(ledger(LIVE)).state).menu.find(entry => entry.kind === "DELETE")).toEqual({
      kind: "DELETE", label: "Delete trade", destructive: true, disabledReason: "Close, skip or cancel the trade first",
    });
    expect(reviewed.menu.find(entry => entry.kind === "DELETE")).toEqual({ kind: "DELETE", label: "Delete trade", destructive: true });
    expect(headerActions(detail(ledger()).state, { trashed: true })).toEqual({ primary: null, secondary: [], menu: [{ kind: "TECHNICAL", label: "Technical details" }] });
  });

  it("offers nothing on an archived account's draft but Discard, says why, and never Duplicate on its trades (§3.2, §9)", () => {
    const approved = ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" });
    const frozen = detail(approved, { checkCurrent: true, aiAvailable: true, archived: true });
    expect(frozen.state).toMatchObject({ label: "Account archived", tone: "muted", nextAction: null, checkCurrent: false });
    expect(headerActions(frozen.state)).toEqual({
      primary: null, secondary: [], menu: [
        { kind: "DISCARD", label: "Discard draft", destructive: true }, { kind: "DELETE", label: "Delete trade", destructive: true },
        { kind: "TECHNICAL", label: "Technical details" },
      ],
    });
    expect(nextStepHint(frozen, NOW, STRATEGY_TIME)).toEqual({ tone: "warning", text: ARCHIVED_DRAFT_HINT });
    // No pre-trade AI selection either (the AI review of a closed trade stays).
    expect(evidenceMode(frozen)).toMatchObject({ selectable: false, max: 0 });
    expect(evidenceMode(detail(ledger(CLOSED), { aiAvailable: true, archived: true })).selectable).toBe(true);
    expect(ARCHIVED_DRAFT_HINT).toBe("This trading account is archived, so this draft can't be edited, checked or locked. Restore the account in Manage account to continue it.");
    // Trades the account already holds are finished as usual; none can be duplicated into the archived account.
    expect(headerActions(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" }), { archived: true }).state)).toMatchObject({
      primary: { kind: "RECORD_ENTRY" }, menu: [{ kind: "SKIP" }, { kind: "DELETE" }, { kind: "TECHNICAL" }],
    });
    expect(headerActions(detail(ledger(LIVE), { archived: true }).state).menu.map(entry => entry.kind)).toEqual(["CLOSE_TRADE", "DELETE", "TECHNICAL"]);
    expect(nextStepHint(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" }), { archived: true }), NOW, STRATEGY_TIME)?.text).toBe(
      "Record the entry when you take the trade, or skip it with a reason.",
    );
  });

  it("says why the next action is next, with the exact first blocking reason", () => {
    const hint = (trade: LedgerTrade, options: DetailOptions = {}) => nextStepHint(detail(trade, options), NOW, STRATEGY_TIME);
    expect(hint(ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "BLOCKED" }), { check: checkView("BLOCKED") }))
      .toEqual({ tone: "danger", text: "Blocked: Requested risk 1.25% exceeds your configured maximum of 0.75%." });
    expect(hint(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { checkCurrent: true, check: checkView("APPROVED") })?.text)
      .toBe("The free risk check approved revision 2 at 13:58. Lock the plan before you enter.");
    expect(hint(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { check: checkView("APPROVED") }))
      .toEqual({ tone: "warning", text: "The approval from 13:58 is no longer current. Recheck risk before locking." });
    expect(hint(ledger({ ...LIVE_FIRST, entry_model: null }))?.text).toContain("Some entry details are still missing");
    expect(hint(ledger({ ...LOCKED, lifecycle: "SKIPPED", disposition: "SKIPPED" }))).toBeNull();
    expect(hint(ledger({ ...LOCKED, lifecycle: "LOCKED" }))?.text).toBe("Record the entry when you take the trade, or skip it with a reason.");
  });

  it("states the facts that matter in each state, with the live duration kept current", () => {
    expect(headerFacts(detail(ledger(LIVE)), NOW, STRATEGY_TIME)).toEqual([{ text: "OB first touch" }, { text: "Entered 03:05", liveSince: "2026-10-23T08:05:00Z" }]);
    expect(headerFacts(detail(ledger(CLOSED)), NOW, STRATEGY_TIME).map(fact => fact.text)).toEqual(["OB first touch", "Entered 03:05", "Closed 05:50 · held 2h 45m"]);
    expect(headerFacts(detail(ledger({ ...LIVE_FIRST, entered_at: null, entry_model: null })), NOW, STRATEGY_TIME).map(fact => fact.text)).toEqual(["Recorded 13:10 · entry time not recorded"]);
    expect(whenLabel("2025-12-31T23:00:00Z", NOW, STRATEGY_TIME)).toBe("Dec 31, 2025, 18:00");
    expect(whenLabel("2026-10-21T13:00:00Z", NOW, STRATEGY_TIME)).toBe("Oct 21, 08:00");
  });

  it("summarizes the realized result with its sign, and says when R is not available", () => {
    expect(resultSummary(detail(ledger(CLOSED)))).toEqual({ r: "+3.06R", money: "+$1,530.00", outcome: "Win", tone: "positive" });
    expect(resultSummary(detail(ledger({ ...CLOSED, net_pnl: "-295", realized_r: null, outcome: "LOSS" })))).toEqual({ r: null, money: "-$295.00", outcome: "Loss", tone: "negative" });
    expect(resultSummary(detail(ledger({ ...CLOSED, net_pnl: "0", realized_r: "0", outcome: "BREAKEVEN" })))?.tone).toBe("neutral");
    expect(resultSummary(detail(ledger(LIVE)))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan, lock, evidence, execution and outcome
// ---------------------------------------------------------------------------------------------------------------------
describe("plan values and the lock confirmation (§6.6, §8.1)", () => {
  it("never shows a planned RR that rounds up across the minimum, and states sizes in the contract's unit", () => {
    const facts = planFacts(detail(ledger()), { proposal: PROPOSAL, check: checkView("APPROVED", "2.99666666"), nominalRisk: "500" });
    expect(facts).toContainEqual({ label: "Planned RR", value: "2.99R" });
    expect(facts).toContainEqual({ label: "Size", value: "0.25 lots" });
    expect(facts).toContainEqual({ label: "Entry", value: "1.10000" });
    expect(facts).toContainEqual({ label: "Risk at stop", value: "$500.00" });
    // Against a known minimum the decimals follow it (formatAgainst), so the verdict and the words agree both ways.
    const rr = (plannedRR: string, minRR: string) => planFacts(detail(ledger()), { proposal: PROPOSAL, check: checkView("APPROVED", plannedRR), nominalRisk: null, minRR })
      .find(fact => fact.label === "Planned RR")?.value;
    expect(rr("2.995", "2.995")).toBe("2.995R");
    expect(rr("1.5075", "1.505")).toBe("1.507R");
    expect(rr("1.505", "1.505")).toBe("1.505R");
    expect(rr("1.50499999", "1.505")).toBe("1.504R");
    expect(rr("2.99666666", "3")).toBe("2.99R");
    expect(rr("3", "3")).toBe("3.00R");
    expect(planFacts(detail(ledger()), { proposal: { ...PROPOSAL, stop: null }, check: null, nominalRisk: null })).toContainEqual({ label: "Stop", value: "Missing", tone: "warning" });
    expect(planChecks({ ...PROPOSAL, news: "RESTRICTED", contractConfirmed: false, contradiction: true })).toEqual([
      { label: "Economic news", value: "Restricted window", tone: "warning" },
      { label: "Contract values", value: "Not confirmed", tone: "warning" },
      { label: "Strategy rules", value: "Contradiction flagged", tone: "warning" },
    ]);
  });

  it("lists what becomes immutable and what locking reserves, with exact decimals", () => {
    const trade = detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { checkCurrent: true, check: checkView("APPROVED") });
    const summary = lockSummary(trade, { slotsUsed: 1, maxDailyTrades: 2, riskUsed: "937.9", dailyRiskCap: "2000", dailyLossCap: "4000" });
    expect(summary.immutable).toEqual([
      "EURUSD · long · OB first touch",
      "Entry 1.10000 · stop 1.09800 · target 1.10600",
      "Risk 0.50% · 0.25 lots · $500.00 at the stop",
      "Thesis and checks (news, contract values, strategy rules)",
    ]);
    expect(summary.reserved).toEqual([
      "1 daily trade: 2 of 2 used today after locking (0 trades left).",
      "$500.00 of your $2,000.00 daily risk cap ($562.10 left after locking).",
      "While open, its risk counts toward your $4,000.00 daily loss limit.",
    ]);
    expect(summary.stillOpen).toBe("Screenshots, journal notes and tags stay open after locking.");
    expect(lockSummary(trade, { slotsUsed: 0, maxDailyTrades: 3, riskUsed: "0", dailyRiskCap: null, dailyLossCap: null }).reserved)
      .toEqual(["1 daily trade: 1 of 3 used today after locking (2 trades left).", "$500.00 of daily risk (no daily risk cap is configured)."]);
    expect(lockSummary(trade, null).reserved).toEqual(["One of today's trade slots and this trade's risk count toward your daily limits."]);
  });

  it("reads a plan locked at its minimum RR as meeting it, from the report of the check it shows (§6.6)", () => {
    // Minimum 2.995R (BLOCK): EURUSD 1.10000 / 1.09800 / 1.10599 plans exactly 2.995R and is approved and locked.
    const { report, check } = engineCheck({ target: "1.10599" }, { minRR: "2.995" });
    expect(report).toMatchObject({ decision: "APPROVED", calculations: { plannedRR: "2.995" } });
    const draft = withReport(detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: CHECKED, draft_check: "APPROVED" }), { check, checkCurrent: true }), report);
    const plannedRR = (source: PlanSource | null) => (source ? planFacts(draft, source).find(fact => fact.label === "Planned RR")?.value : undefined);
    expect(draftSource(draft)?.minRR).toBe("2.995");
    expect(plannedRR(draftSource(draft))).toBe("2.995R");
    // The locked plan reads its own report at lock; a never-locked draft the report of its last check.
    const locked = detail(ledger({ ...LOCKED, lifecycle: "LOCKED" }));
    const sealed: TradeDetail = {
      ...locked, plan: { ...(locked.plan as NonNullable<TradeDetail["plan"]>), check }, technical: { ...locked.technical, planReport: report },
    };
    expect(plannedRR(lockedSource(sealed))).toBe("2.995R");
    const discarded = withReport(detail(ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: NOW }), { check }), report);
    expect(plannedRR(lastRevisionSource(discarded, PROPOSAL))).toBe("2.995R");
    // Without a readable report 1.2 the minimum is unknown: 2 decimals, truncated.
    expect(plannedRR(draftSource(detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: CHECKED, draft_check: "APPROVED" }), { check })))).toBe("2.99R");
    // An older report (engine 1.0 or 1.1, V1-migrated plans) states no limits: the check view carries the minimum of the
    // risk plan version it was evaluated with, the one Plan vs reality compares with too.
    const older: CheckView = { ...check, minRR: "2.995" };
    expect(plannedRR(draftSource(detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: CHECKED, draft_check: "APPROVED" }), { check: older })))).toBe("2.995R");
    expect(plannedRR(lockedSource({ ...locked, plan: { ...(locked.plan as NonNullable<TradeDetail["plan"]>), check: older } }))).toBe("2.995R");
    const ended = detail(ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: NOW }), { check: older });
    expect(plannedRR(lastRevisionSource(ended, PROPOSAL))).toBe("2.995R");
    expect(planVsReality(ledger({ ...LIVE, planned_rr: "2.995" }), EURUSD, { minRR: "2.995" }).rows.find(row => row.key === "RR")?.planned).toBe("2.995R");
  });

  it("never understates money at risk or overstates the room a lock leaves (§6.6)", () => {
    // USDJPY-like sizing: the engine's nominal risk 530.452 reads $530.46 wherever the page or the lock dialog states it.
    const check: CheckView = { ...checkView("APPROVED"), calculations: { quantity: "4.04", nominalRisk: "530.452", plannedRR: "3", budget: "531.25", stopDistance: "0.202" } };
    const trade = detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { checkCurrent: true, check });
    expect(planFacts(trade, draftSource(trade) as PlanSource)).toContainEqual({ label: "Risk at stop", value: "$530.46" });
    const summary = lockSummary(trade, { slotsUsed: 1, maxDailyTrades: 3, riskUsed: "500", dailyRiskCap: "3533.31", dailyLossCap: null });
    expect(summary.immutable[2]).toBe("Risk 0.50% · 4.04 lots · $530.46 at the stop");
    // 3533.31 − 500 − 530.452 = 2502.858: never promised as $2,502.86.
    expect(summary.reserved[1]).toBe("$530.46 of your $3,533.31 daily risk cap ($2,502.85 left after locking).");
    expect(lockSummary(trade, { slotsUsed: 0, maxDailyTrades: 3, riskUsed: "0", dailyRiskCap: null, dailyLossCap: null }).reserved[1])
      .toBe("$530.46 of daily risk (no daily risk cap is configured).");
    expect(lockSummary(trade, { slotsUsed: 0, maxDailyTrades: 3, riskUsed: "3200", dailyRiskCap: "3533.31", dailyLossCap: null }).reserved[1])
      .toBe("$530.46 of your $3,533.31 daily risk cap ($0.00 left after locking).");
    // The R basis reads the same amount as "Risk at stop".
    const live = detail(ledger({ ...LIVE, initial_risk: "530.452", planned_risk: "530.452" }));
    expect(riskBasisPreview(live)).toBe("R based on locked risk: realized R = net P&L ÷ $530.46.");
    expect(outcomeView(detail(ledger({ ...CLOSED, initial_risk: "530.452" })), NOW, STRATEGY_TIME)?.basis).toBe("R based on locked risk · realized R = net P&L ÷ $530.46");
    const liveFirst = detail(ledger({ ...LIVE_FIRST, initial_risk: "51.805" }));
    expect(positionFacts(liveFirst, NOW, STRATEGY_TIME).find(fact => fact.label === "Risk at stop")?.value).toBe("$51.81");
    // Plan vs reality on the same page states the locked and the actual risk at the stop the same way.
    const pvr = planVsReality(ledger({ ...LIVE, planned_risk: "530.452", actual_initial_risk: "1060.904" }), EURUSD);
    expect(pvr.kind === "PLANNED" ? pvr.rows.find(row => row.key === "RISK") : null).toMatchObject({ planned: "$530.46", actual: "$1,060.91" });
  });

  it("marks a contract confirmation the account's newer contract replaced", () => {
    expect(planChecks(PROPOSAL, { contractUpdated: true })[1]).toEqual({ label: "Contract values", value: "Confirmed before the contract update", tone: "warning" });
    expect(planChecks({ ...PROPOSAL, contractConfirmed: false }, { contractUpdated: true })[1]).toEqual({ label: "Contract values", value: "Not confirmed", tone: "warning" });
    expect(planChecks(PROPOSAL)[1]).toEqual({ label: "Contract values", value: "Match my broker" });
  });

  it("says why Lock plan can't run yet", () => {
    expect(lockBlockedReason({ draftCheck: "APPROVED", checkCurrent: true })).toBeNull();
    expect(lockBlockedReason({ draftCheck: "APPROVED", checkCurrent: false })).toBe("Recheck risk first: the last approval is no longer current.");
    expect(lockBlockedReason({ draftCheck: "BLOCKED", checkCurrent: false })).toContain("Locking opens once a check approves this revision.");
    expect(lockBlockedReason({ draftCheck: "UNCHECKED", checkCurrent: false })).toBe("Run the free risk check first: locking needs an approval of this revision.");
  });

  it("describes a locked plan as §14.4 does and keeps never-locked drafts readable from the ledger", () => {
    const locked = detail(ledger({ ...LOCKED, lifecycle: "LOCKED" }));
    expect(lockedLine(locked.plan as NonNullable<TradeDetail["plan"]>, NOW, STRATEGY_TIME)).toBe("Locked 02:52 · Risk Plan V1.1 · ICT V1.0 · immutable");
    const discarded = detail(ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: NOW }), { check: checkView("BLOCKED") });
    const fallback = lastRevisionSource(discarded, null);
    expect(fallback.proposal).toMatchObject({ entry: "1.1", stop: "1.098", target: "1.106", riskPercent: "0.5", narrative: null, news: null });
    expect(fallback.check?.decision).toBe("BLOCKED");
    expect(lastRevisionSource(discarded, PROPOSAL).proposal).toBe(PROPOSAL);
  });
});

describe("evidence capture and AI selection (§7.1, §7.5)", () => {
  it("routes page paste to the evidence stager before entry and to the journal after it", () => {
    expect(evidenceMode(detail(ledger(), { aiAvailable: true })))
      .toEqual({ selectable: true, max: 3, pasteTo: "evidence", timingHint: "BEFORE_ENTRY", defaultLabel: "PRE_ENTRY", remaining: 24 });
    expect(evidenceMode(detail(ledger(), { aiAvailable: false })).selectable).toBe(false);
    expect(evidenceMode(detail(ledger(LIVE), { aiAvailable: true, evidenceActive: 3 })))
      .toEqual({ selectable: false, max: 0, pasteTo: "journal", timingHint: "WHILE_LIVE", defaultLabel: "MANAGEMENT", remaining: 21 });
    expect(evidenceMode(detail(ledger(CLOSED), { aiAvailable: true }))).toMatchObject({ selectable: true, max: 4, pasteTo: "journal", timingHint: "AFTER_CLOSE", defaultLabel: "EXIT" });
    expect(evidenceMode(detail(ledger(), { evidenceActive: 30 })).remaining).toBe(0);
  });

  it("never stages a screenshot of a plan that ended without an entry as pre-entry evidence (§5.3)", () => {
    const ended = [
      ledger({ ...LOCKED, lifecycle: "SKIPPED", disposition: "SKIPPED" }),
      ledger({ ...LOCKED, lifecycle: "CANCELLED", disposition: "CANCELLED" }),
      ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: NOW }),
    ];
    for (const trade of ended) {
      const mode = evidenceMode(detail(trade, { aiAvailable: true }));
      expect(mode).toMatchObject({ selectable: false, pasteTo: "evidence", timingHint: "AFTER_CLOSE", defaultLabel: "OTHER" });
      // The stager offers its default plus HTF, Context, Entry and Other: Pre-entry can't be chosen at all.
      expect(labelOptionsForDefault(mode.defaultLabel)).not.toContain("PRE_ENTRY");
    }
    expect(labelOptionsForDefault(evidenceMode(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" }))).defaultLabel)).toContain("PRE_ENTRY");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Records added after a plan ended: the trade detail classifies them (§5.3); the workspace words them
// ---------------------------------------------------------------------------------------------------------------------
function record(id: string, kind: TimelineKind, recordedAt: string, timing: Timing = "BEFORE_ENTRY", changes: Partial<TimelineItem> = {}): TimelineItem {
  return { id, kind, at: recordedAt, recordedAt, timing, flags: [], title: id, source: id, timeLabel: "", ...changes };
}

function screenshot(n: number, recordedAt: string, changes: Partial<EvidenceItemView> = {}): EvidenceItemView {
  return {
    kind: "V2", src: `/api/evidence/${uuid(n)}`, thumbSrc: `/api/evidence/${uuid(n)}?variant=thumb`, id: uuid(n), name: "M5 chart", label: "PRE_ENTRY", timeframe: "M5",
    caption: null, timing: "BEFORE_ENTRY", timingLabel: "Before entry", flags: [], recordedAt, removedAt: null, copiedFromRecordedAt: null, copied: false,
    originalFilename: "chart.png", mimeType: "image/png", width: 1600, height: 900, byteSize: 1000, relabelable: true, removable: true, ...changes,
  };
}

const SKIPPED_AT = "2026-10-23T09:55:00.000000+00:00";
const AFTER_CLOSE = { timing: "AFTER_CLOSE" as const, timingLabel: "After close" };

/** A plan skipped at 04:55 UTC−5 with a lesson, a screenshot and a removed screenshot recorded after the skip, as loaded. */
function skippedWithHindsight(status: "SKIPPED" | "CANCELLED" = "SKIPPED"): TradeDetail {
  return detail(ledger({ ...LOCKED, lifecycle: status, disposition: status, disposition_reason: "No retest." }), {
    disposition: { status, reason: "No retest.", recordedAt: SKIPPED_AT },
    timeline: [
      record("revision", "DRAFT_REVISION", "2026-10-23T07:40:00Z"),
      record("plan", "PLAN_LOCKED", "2026-10-23T07:52:00Z"),
      record("evidence-added:early", "EVIDENCE_ADDED", "2026-10-23T07:55:00Z", "BEFORE_ENTRY", { evidenceId: uuid(41) }),
      record("disposition", "DISPOSITION", SKIPPED_AT),
      record("journal:lesson", "JOURNAL", "2026-10-23T10:16:00Z", "AFTER_CLOSE", { journalKind: "LESSON", body: "Price ran to target without me." }),
      record("evidence-added:late", "EVIDENCE_ADDED", "2026-10-23T10:16:30Z", "AFTER_CLOSE", { evidenceId: uuid(42) }),
    ],
    evidenceItems: [
      screenshot(41, "2026-10-23T07:55:00Z"),
      screenshot(42, "2026-10-23T10:16:30Z", { ...AFTER_CLOSE, label: "OTHER" }),
      screenshot(43, "2026-10-23T10:20:00Z", { ...AFTER_CLOSE, removedAt: "2026-10-23T10:30:00Z" }),
    ],
  });
}

describe("records added after a plan ended (§5.3)", () => {
  it("dates the end of a plan that ended without an entry, and only then", () => {
    expect(skippedWithHindsight().planEndedAt).toBe(SKIPPED_AT);
    expect(detail(ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: "2026-10-23T18:44:00Z" })).planEndedAt).toBe("2026-10-23T18:44:00Z");
    for (const trade of [ledger(), ledger({ ...LOCKED, lifecycle: "LOCKED" }), ledger(LIVE), ledger(CLOSED)]) expect(detail(trade).planEndedAt).toBeNull();
  });

  it("labels lessons and new entries of a plan that ended as written after it", () => {
    const view = skippedWithHindsight();
    const [lesson] = lessonsOf(view.timeline);
    expect(lessonTiming(lesson, "SKIPPED")).toBe("After the skip");
    expect(lessonTiming(lesson, "CANCELLED")).toBe("After the cancellation");
    expect(lessonTiming(lesson, "CLOSED")).toBe("After close");
    expect(lessonTiming({ timing: "BEFORE_ENTRY" }, "SKIPPED")).toBe("Before entry");
    const mode = evidenceMode(view);
    expect(mode).toMatchObject({ timingHint: "AFTER_CLOSE", defaultLabel: "OTHER" });
    expect(newEntriesLabel(view, mode)).toBe("after the skip");
    expect(newEntriesLabel(detail(ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: NOW })), mode)).toBe("after the discard");
    expect(newEntriesLabel(detail(ledger()), evidenceMode(detail(ledger())))).toBe("Before entry");
    expect(newEntriesLabel(detail(ledger(LIVE)), evidenceMode(detail(ledger(LIVE))))).toBe("While live");
  });

  it("says what duplicating copies: screenshots added after the plan ended stay with the trade (§7.4)", () => {
    const base = [
      "Economic news is reset to “Not checked”: verify it again for the new trade.",
      "Screenshots recorded before entry are copied; live and after-close screenshots are not.",
    ];
    // The removed screenshot counts for nothing; the early one is genuine pre-entry evidence and is copied.
    expect(duplicateNotes(skippedWithHindsight())).toEqual([...base, "1 screenshot added after the skip stays with this trade."]);
    const cancelled = skippedWithHindsight("CANCELLED");
    const twoLater: TradeDetail = { ...cancelled, evidence: { ...cancelled.evidence, items: [...cancelled.evidence.items, screenshot(44, "2026-10-23T11:00:00Z", AFTER_CLOSE)] } };
    expect(duplicateNotes(twoLater)[2]).toBe("2 screenshots added after the cancellation stay with this trade.");
    // A closed trade's after-close screenshots are covered by the general sentence.
    expect(duplicateNotes(detail(ledger(CLOSED), { evidenceItems: [screenshot(45, "2026-10-23T18:50:00Z", AFTER_CLOSE)] }))).toEqual(base);
    expect(duplicateNotes(detail(ledger({ ...LOCKED, lifecycle: "SKIPPED", disposition: "SKIPPED" }), { disposition: { status: "SKIPPED", reason: "x", recordedAt: SKIPPED_AT } }))).toEqual(base);
  });
});

describe("a block recorded on an earlier trading day (§2.4, §6.3)", () => {
  const YESTERDAY = "2026-10-22T18:44:00Z"; // Thu Oct 22, 13:44 UTC−5
  const MAX_TRADES = { code: "MAX_TRADES", severity: "BLOCK" as const, title: "Daily trade limit reached", detail: "Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live)." };
  const RISK_LIMIT = { code: "RISK_LIMIT", severity: "BLOCK" as const, title: "Requested risk exceeds maximum", detail: "Requested risk 1.25% exceeds your configured maximum of 0.75%." };
  const blockedAt = (recordedAt: string, blocking = [MAX_TRADES]) => {
    const check: CheckView = { ...checkView("BLOCKED"), recordedAt, explained: { decision: "BLOCKED", blocking, warnings: [], notes: [] } };
    return detail(ledger({ latest_check_decision: "BLOCKED", latest_check_at: recordedAt, draft_check: "BLOCKED" }), { check });
  };

  it("leads with the free recheck the trade's state chose, and says when the block was recorded", () => {
    const stale = blockedAt(YESTERDAY);
    expect(blockedOnEarlierDay(stale)).toBe(true);
    expect(nextStepHint(stale, NOW, STRATEGY_TIME)).toEqual({
      tone: "warning",
      text: "Blocked when checked Oct 22, 13:44: Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live). Today's limits and session can differ, so recheck risk before you edit the draft.",
    });
    // The header reads deriveTradeState's next action, the one Today, the Journal and the command palette read too.
    expect(stale.state.nextAction).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
    const actions = headerActions(pageState(stale));
    expect(actions.primary).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
    expect(actions.secondary.map(action => action.label)).toEqual(["Edit draft"]);
    expect(actions.menu.map(entry => [entry.kind, entry.compactOnly ?? false])).toEqual([["EDIT_DRAFT", true], ["DUPLICATE", false], ["DISCARD", false], ["DELETE", false], ["TECHNICAL", false]]);
    // A block from today that an edit can clear keeps Edit draft as the next action with the exact reason (§2.4).
    const today = blockedAt("2026-10-23T18:44:00Z", [RISK_LIMIT]);
    expect(blockedOnEarlierDay(today)).toBe(false);
    expect(headerActions(pageState(today)).primary).toEqual({ kind: "EDIT_DRAFT", label: "Edit draft", detail: RISK_LIMIT.detail });
    expect(nextStepHint(today, NOW, STRATEGY_TIME)?.text).toBe(`Blocked: ${RISK_LIMIT.detail}`);
    // Only a blocked draft is led by a recheck for its day: a current approval keeps Lock plan.
    const ready = detail(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }), { checkCurrent: true });
    expect(blockedOnEarlierDay(ready)).toBe(false);
    expect(headerActions(pageState(ready)).primary?.label).toBe("Lock plan");
  });

  it("says a block from an earlier day is resolved by a recheck first", () => {
    const blocked = { draftCheck: "BLOCKED" as const, checkCurrent: false };
    expect(blockingCheckOf(blockedAt(YESTERDAY))).toEqual({
      checkedAt: YESTERDAY, codes: ["MAX_TRADES"], findings: [{ code: "MAX_TRADES" }], equity: null, maxRiskPercent: null, minimumRisk: null, currency: "USD",
    });
    expect(lockBlockedReason(blocked, block(["RISK_LIMIT"], YESTERDAY), NOW)).toBe(
      "Locking opens once a check approves this revision. This check is from Oct 22; today's limits and session can differ, so recheck risk before you edit the draft.",
    );
    expect(lockBlockedReason(blocked, block(["RISK_LIMIT"], "2025-12-31T18:00:00Z"), NOW)).toContain("This check is from Dec 31, 2025;");
  });
});

/** A blocking check from today (13:44 UTC−5) with these reasons and no report amounts. */
function block(codes: readonly string[], checkedAt = "2026-10-23T18:44:00Z", changes: Partial<BlockingCheck> = {}): BlockingCheck {
  return { checkedAt, codes, findings: codes.map(code => ({ code })), equity: null, maxRiskPercent: null, minimumRisk: null, currency: "USD", ...changes };
}

describe("a block found today: what an edit clears, and what only time or the account values clear (§2.4, §6.3, §10)", () => {
  const blocked = { draftCheck: "BLOCKED" as const, checkCurrent: false };
  const DEAD_POOL_NOW = NOW; // 14:00 UTC−5
  const EVENING = "2026-10-23T23:30:00Z"; // 18:30 UTC−5, same trading day

  /** A draft whose latest check is the engine's report: the page reads its amounts from Technical details. */
  const engineDraft = (...args: Parameters<typeof engineCheck>) => {
    const { report, check, ctx } = engineCheck(...args);
    const trade = detail(ledger({ latest_check_decision: report.decision, latest_check_at: CHECKED, draft_check: report.decision }), { check });
    return { trade: withReport(trade, report), report, ctx };
  };
  /** The engine's verdict on the same plan at another risk, in the same context. */
  const approvedAt = (riskPercent: string, ctx: RiskContext) => evaluateRisk({ ...previewProposal, narrative: "x", contractConfirmed: true, news: "CLEAR", riskPercent }, ctx).decision;

  it("never says an edit won't help when a lower risk fits the daily risk cap, and names the risk that fits", () => {
    // Cap 70, 50 already reserved: the $50 trade doesn't fit the $20 left; 0.20% (a $20 budget, 0.10 lots, $20 at the stop) does.
    const { trade, ctx } = engineDraft({}, { dailyRiskCap: "70" }, { plannedRisk: "50", plannedSlots: 1 });
    expect(trade.draft?.latestCheck?.explained.blocking.map(issue => issue.code)).toEqual(["DAILY_RISK_LIMIT"]);
    const reason = lockBlockedReason(blocked, blockingCheckOf(trade), DEAD_POOL_NOW);
    expect(reason).toBe("Locking opens once a check approves this revision. Edit the draft to resolve the reason above, then check again. A risk of 0.20% or less fits the $20.00 of daily risk left.");
    expect(reason).not.toContain("won't clear");
    // The budget never exceeds the room, so the hinted risk always fits; the size steps may let a little more fit.
    expect(approvedAt("0.2", ctx)).toBe("APPROVED");
    expect(approvedAt("0.25", ctx)).toBe("BLOCKED");
    expect(headerActions(pageState(trade)).primary?.kind).toBe("EDIT_DRAFT");
    expect(nextStepHint(trade, DEAD_POOL_NOW, STRATEGY_TIME)?.text).toMatch(/^Blocked: Remaining daily risk \$20\.00 is insufficient for this trade's \$50\.00 risk/);
  });

  it("names the risk that fits the room left under the daily loss limit, and the tighter cap when both block", () => {
    const loss = engineDraft({}, { dailyLossCap: "100" }, { realizedLoss: "60" });
    expect(lockBlockedReason(blocked, blockingCheckOf(loss.trade), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Edit the draft to resolve the reason above, then check again. A risk of 0.40% or less fits the $40.00 left under your daily loss limit.",
    );
    expect(approvedAt("0.4", loss.ctx)).toBe("APPROVED");
    const both = engineDraft({}, { dailyRiskCap: "100", dailyLossCap: "100" }, { plannedRisk: "70", plannedSlots: 1, realizedLoss: "55" });
    expect(both.trade.draft?.latestCheck?.explained.blocking.map(issue => issue.code)).toEqual(["DAILY_RISK_LIMIT", "DAILY_LOSS_LIMIT"]);
    expect(lockBlockedReason(blocked, blockingCheckOf(both.trade), DEAD_POOL_NOW)).toContain("A risk of 0.30% or less fits the $30.00 of daily risk left.");
    expect(approvedAt("0.3", both.ctx)).toBe("APPROVED");
    // A room the minimum size can't fit at this stop: no risk is suggested.
    const tiny = engineDraft({}, { dailyRiskCap: "51" }, { plannedRisk: "50", plannedSlots: 1 });
    expect(lockBlockedReason(blocked, blockingCheckOf(tiny.trade), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Edit the draft to resolve the reason above, then check again. Only $1.00 of daily risk is left: even the minimum size risks $2.00 at this stop.",
    );
  });

  it("says what a duplicate must change instead of telling the trader to wait", () => {
    const { trade } = engineDraft({}, {}, {}, { duplicate: true });
    expect(lockBlockedReason(blocked, blockingCheckOf(trade), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Edit the draft to resolve the reason above, then check again. Change the instrument, direction, model, entry, stop or target so it differs from the plan already locked today.",
    );
    expect(headerActions(pageState(trade)).primary?.kind).toBe("EDIT_DRAFT");
  });

  it("leads with Recheck risk when only the next trading day clears the block, and says so", () => {
    // Daily trade limit reached, and a daily risk cap with nothing left.
    for (const { trade, sentence } of [
      { trade: engineDraft({}, {}, { plannedSlots: 2, plannedRisk: "60" }).trade, sentence: "The daily trade limit is used up for today: recheck risk on the next trading day." },
      { trade: engineDraft({}, { dailyRiskCap: "50" }, { plannedRisk: "50", plannedSlots: 1 }).trade, sentence: "The daily risk cap is used up for today: recheck risk on the next trading day." },
      { trade: engineDraft({}, { dailyLossCap: "100" }, { realizedLoss: "100" }).trade, sentence: "The daily loss limit is used up for today: recheck risk on the next trading day." },
    ]) {
      const reasons = trade.draft?.latestCheck?.explained.blocking ?? [];
      expect(lockBlockedReason(blocked, blockingCheckOf(trade), DEAD_POOL_NOW)).toBe(
        `Locking opens once a check approves this revision. Editing the draft won't clear ${reasons.length > 1 ? "these reasons" : "this reason"}. ${sentence}`,
      );
      const actions = headerActions(pageState(trade));
      expect(actions.primary).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
      expect(actions.secondary.map(action => action.label)).toEqual(["Edit draft"]);
      expect(nextStepHint(trade, DEAD_POOL_NOW, STRATEGY_TIME)?.text).toMatch(new RegExp(`${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      // The trade's own state is unchanged: only the page leads with the step that clears it.
      expect(trade.state.nextAction?.kind).toBe("EDIT_DRAFT");
    }
    // Both limits at once read as one sentence.
    expect(lockBlockedReason(blocked, block(["MAX_TRADES", "DAILY_RISK_LIMIT"], undefined, { findings: [{ code: "MAX_TRADES" }, { code: "DAILY_RISK_LIMIT", room: "0" }] }), DEAD_POOL_NOW))
      .toBe("Locking opens once a check approves this revision. Editing the draft won't clear these reasons. The daily trade limit and the daily risk cap are used up for today: recheck risk on the next trading day.");
  });

  it("waits for open positions when they fill the daily loss limit, and for the end of Dead Pool", () => {
    const open = engineDraft({}, { dailyLossCap: "100" }, { realizedLoss: "40", openExposure: "60" }).trade;
    // Checked in the kill zone; it is Dead Pool now, where any recheck blocks: the recheck waits for both.
    expect(lockBlockedReason(blocked, blockingCheckOf(open), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear this reason. Today's losses and open risk fill your daily loss limit: recheck risk once Dead Pool ends at 18:00 UTC−5 and an open position closes, or on the next trading day.",
    );
    expect(lockBlockedReason(blocked, blockingCheckOf(open), EVENING)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear this reason. Today's losses and open risk fill your daily loss limit: recheck risk once an open position closes, or on the next trading day.",
    );
    expect(headerActions(pageState(open)).primary?.kind).toBe("RECHECK_RISK");
    // Dead Pool: the recheck once it ends at 18:00, or now once it has ended (the reason has lapsed: nothing to wait for).
    const deadPool = block(["DEAD_POOL"]);
    expect(lockBlockedReason(blocked, deadPool, DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear this reason. Recheck risk once Dead Pool ends at 18:00 UTC−5.",
    );
    expect(lockBlockedReason(blocked, deadPool, EVENING)).toBe("Locking opens once a check approves this revision. Dead Pool has ended: recheck risk now.");
    // With a reason an edit clears, the edit comes first and the wait says when to recheck.
    expect(lockBlockedReason(blocked, block(["RISK_LIMIT", "DEAD_POOL"]), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Edit the draft for the reason an edit clears. Recheck risk once Dead Pool ends at 18:00 UTC−5.",
    );
    expect(lockBlockedReason(blocked, block(["RISK_LIMIT", "MIN_RR", "MAX_TRADES"]), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Edit the draft for the reasons an edit clears. The daily trade limit is used up for today: recheck risk on the next trading day.",
    );
    expect(lockBlockedReason(blocked, block(["RISK_LIMIT"]), DEAD_POOL_NOW)).toBe("Locking opens once a check approves this revision. Edit the draft to resolve the reason above, then check again.");
  });

  it("leads with Confirm account values when only today's values are missing", () => {
    const { trade } = engineDraft({}, {}, {}, { observationDay: "2026-10-22" });
    expect(trade.draft?.latestCheck?.explained.blocking.map(issue => issue.code)).toEqual(["STALE_EQUITY"]);
    expect(lockBlockedReason(blocked, blockingCheckOf(trade), EVENING)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear this reason. Confirm today's account values, then recheck risk.",
    );
    // During Dead Pool the recheck after confirming would block on it: it waits for 18:00.
    expect(lockBlockedReason(blocked, blockingCheckOf(trade), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear this reason. Confirm today's account values, then recheck risk once Dead Pool ends at 18:00 UTC−5.",
    );
    const actions = headerActions(pageState(trade));
    expect(actions.primary).toEqual({ kind: "CONFIRM_VALUES", label: "Confirm account values" });
    expect(actions.secondary.map(action => action.label)).toEqual(["Edit draft"]);
    expect(nextStepHint(trade, EVENING, STRATEGY_TIME)).toEqual({
      tone: "danger", text: "Blocked: Confirm today's account balance before locking (last recorded Oct 22). Confirm today's account values, then recheck risk.",
    });
    expect(lockBlockedReason(blocked, block(["STALE_EQUITY", "DEAD_POOL"]), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear these reasons. Confirm today's account values, then recheck risk once Dead Pool ends at 18:00 UTC−5.",
    );
  });

  it("leads with Recheck risk once today's account values have been confirmed since the check, not with a second confirmation", () => {
    const { trade } = engineDraft({}, {}, {}, { observationDay: "2026-10-22" });
    const usage = { slotsUsed: 0, maxDailyTrades: 2, riskUsed: "0", dailyRiskCap: null, dailyLossCap: null };
    // The account workspace's latest values: still from Oct 22, or confirmed for today (Oct 23) after the check.
    const before = blockingNow(lockSummary(trade, { ...usage, valuesDay: "2026-10-22" }), EVENING);
    const after = blockingNow(lockSummary(trade, { ...usage, valuesDay: "2026-10-23" }), EVENING);
    expect(before).toEqual({});
    expect(after).toEqual({ valuesConfirmedToday: true });
    expect(blockingNow(null, EVENING)).toEqual({});
    expect(headerActions(pageState(trade, before)).primary?.kind).toBe("CONFIRM_VALUES");
    const actions = headerActions(pageState(trade, after));
    expect(actions.primary).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
    expect(actions.secondary.map(action => action.label)).toEqual(["Edit draft"]);
    expect(nextStepHint(trade, EVENING, STRATEGY_TIME, after)).toEqual({
      tone: "danger",
      text: "Blocked: Confirm today's account balance before locking (last recorded Oct 22). Today's account values have been confirmed since the check: recheck risk now.",
    });
    expect(lockBlockedReason(blocked, blockingCheckOf(trade, after), EVENING)).toBe(
      "Locking opens once a check approves this revision. Today's account values have been confirmed since the check: recheck risk now.",
    );
    // During Dead Pool the recheck still waits for its end.
    expect(lockBlockedReason(blocked, blockingCheckOf(trade, after), DEAD_POOL_NOW)).toBe(
      "Locking opens once a check approves this revision. Today's account values have been confirmed since the check: recheck risk once Dead Pool ends at 18:00 UTC−5.",
    );
    // The recheck the page leads with approves: the engine on today's values.
    const { report } = engineCheck({}, {}, {}, { observationDay: "2026-10-23" });
    expect(report.decision).toBe("APPROVED");
    // A used-up day still waits for tomorrow, whatever the values.
    const both = block(["STALE_EQUITY", "MAX_TRADES"], undefined, { findings: [{ code: "STALE_EQUITY", valuesConfirmed: true }, { code: "MAX_TRADES" }] });
    expect(lockBlockedReason(blocked, both, EVENING)).toBe(
      "Locking opens once a check approves this revision. Editing the draft won't clear these reasons. The daily trade limit is used up for today: recheck risk on the next trading day.",
    );
  });

  it("waits for the next trading day when today's losses alone fill the daily loss limit, whatever is still open", () => {
    // $100 lost today against a $100 limit, with $60 still open: closing that position, even at break-even, frees nothing.
    const { trade, ctx } = engineDraft({}, { dailyLossCap: "100" }, { realizedLoss: "100", openExposure: "60" });
    expect(trade.draft?.latestCheck?.explained.blocking.map(issue => issue.code)).toEqual(["DAILY_LOSS_LIMIT"]);
    const sentence = "The daily loss limit is used up for today: recheck risk on the next trading day.";
    expect(lockBlockedReason(blocked, blockingCheckOf(trade), EVENING)).toBe(`Locking opens once a check approves this revision. Editing the draft won't clear this reason. ${sentence}`);
    expect(nextStepHint(trade, EVENING, STRATEGY_TIME)?.text).toMatch(new RegExp(`${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(headerActions(pageState(trade)).primary?.kind).toBe("RECHECK_RISK");
    // The engine agrees: with the position closed at break-even (no open risk), the same plan is still blocked.
    expect(evaluateRisk({ ...previewProposal, narrative: "x", contractConfirmed: true, news: "CLEAR" }, { ...ctx, usage: usageFixture({ ...ctx.usage, openExposure: "0" }) }).issues
      .filter(issue => issue.severity === "BLOCK").map(issue => issue.code)).toEqual(["DAILY_LOSS_LIMIT"]);
  });

  it("names how many more reasons stop the plan after the first, in the header", () => {
    const { trade } = engineDraft({ riskPercent: "1" }, { dailyRiskCap: "70" }, { plannedRisk: "50", plannedSlots: 1 });
    const reasons = trade.draft?.latestCheck?.explained.blocking ?? [];
    expect(reasons.map(issue => issue.code)).toEqual(["RISK_LIMIT", "DAILY_RISK_LIMIT"]);
    expect(nextStepHint(trade, DEAD_POOL_NOW, STRATEGY_TIME)).toEqual({ tone: "danger", text: `Blocked: ${reasons[0].detail} (+1 more)` });
    // An older report without amounts: an edit is taken to help, and the reason count still shows.
    expect(blockingFindingsOf(["RISK_LIMIT", "DAILY_RISK_LIMIT"], null)).toEqual([{ code: "RISK_LIMIT" }, { code: "DAILY_RISK_LIMIT" }]);
  });
});

describe("skip confirmation (§2.4, §6.2)", () => {
  it("names the trading day whose trade limit a skipped plan keeps counting toward", () => {
    const lockedToday = detail(ledger({ ...LOCKED, lifecycle: "LOCKED" }));
    expect(skipSlotNote(lockedToday, NOW)).toBe("It still counts as one of today's planned trades.");
    const plan = lockedToday.plan as NonNullable<TradeDetail["plan"]>;
    expect(skipSlotNote({ ...lockedToday, plan: { ...plan, tradingDay: "2026-10-22" } }, NOW)).toBe("It still counts as one of Oct 22's planned trades.");
    expect(skipSlotNote({ ...lockedToday, plan: { ...plan, tradingDay: "2025-12-31" } }, NOW)).toBe("It still counts as one of Dec 31, 2025's planned trades.");
    // Without the plan row the ledger still names the lock's strategy day (or its lock time does): never "today" by default.
    const withLedger = (changes: Partial<LedgerTrade>) => detail(ledger({ ...LOCKED, lifecycle: "LOCKED", plan_id: null, locked_at: null, ...changes }));
    expect(skipSlotNote(withLedger({ plan_trading_day: "2026-10-21" }), NOW)).toBe("It still counts as one of Oct 21's planned trades.");
    // 23:30 UTC on Oct 22 is 18:30 UTC−5, still Oct 22's strategy day.
    expect(skipSlotNote(withLedger({ locked_at: "2026-10-22T23:30:00Z" }), NOW)).toBe("It still counts as one of Oct 22's planned trades.");
    expect(skipSlotNote(withLedger({ locked_at: "2026-10-23T07:52:00Z" }), NOW)).toBe("It still counts as one of today's planned trades.");
    expect(skipSlotNote(withLedger({}), NOW)).toBe("It still counts as one of the planned trades of the day it was locked.");
  });

  it("titles the confirmation by the choice and never labels the way out “Cancel”", () => {
    expect(skipDialogCopy("SKIPPED", "It still counts as one of Oct 22's planned trades.")).toEqual({
      title: "Skip this trade?",
      description: "The locked plan stays in your history with your reason. It still counts as one of Oct 22's planned trades.",
      confirmLabel: "Skip trade",
      cancelLabel: "Keep plan",
    });
    expect(skipDialogCopy("CANCELLED", "x")).toMatchObject({ title: "Cancel this plan?", confirmLabel: "Cancel plan", cancelLabel: "Keep plan" });
  });
});

describe("returning focus after a dialog opened from a menu (§13.5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubPage() {
    vi.useFakeTimers();
    const body = { isConnected: true, classList: { contains: () => false } };
    const page = { dialogOpen: true, active: { isConnected: true, classList: { contains: () => false } } as unknown };
    vi.stubGlobal("window", { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    vi.stubGlobal("document", { body, get activeElement() { return page.active; }, querySelector: () => (page.dialogOpen ? {} : null) });
    return { body, page };
  }

  it("waits for the dialog to leave, then focuses the menu button if focus fell to the page", () => {
    const { body, page } = stubPage();
    const button = { isConnected: true, focus: vi.fn() };
    returnFocusTo(button as unknown as HTMLElement);
    vi.advanceTimersByTime(300);
    expect(button.focus).not.toHaveBeenCalled();
    page.dialogOpen = false;
    page.active = body;
    vi.advanceTimersByTime(60);
    expect(button.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    vi.advanceTimersByTime(3000);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves focus the person moved elsewhere, and a button that left the page", () => {
    const { page } = stubPage();
    const button = { isConnected: true, focus: vi.fn() };
    returnFocusTo(button as unknown as HTMLElement);
    page.dialogOpen = false;
    vi.advanceTimersByTime(3000);
    expect(button.focus).not.toHaveBeenCalled();
    const gone = { isConnected: false, focus: vi.fn() };
    returnFocusTo(gone as unknown as HTMLElement);
    vi.advanceTimersByTime(3000);
    expect(gone.focus).not.toHaveBeenCalled();
    expect(() => returnFocusTo(null)).not.toThrow();
  });
});

describe("links into the trade page (§14.4, §13.5)", () => {
  /** A minimal DOM: elements with ids, children, `<details>` panels, focus and scrolling. */
  class FakeNode {
    open = false;
    parent: FakeNode | null = null;
    /** Distance from the top of the page. */
    top = 0;
    readonly children: FakeNode[] = [];
    readonly focus = vi.fn();
    readonly scrollIntoView = vi.fn();
    constructor(readonly tag: string, readonly id = "", readonly attributes: Record<string, string> = {}) {}
    get parentElement(): FakeNode | null {
      return this.parent;
    }
    getBoundingClientRect() {
      return { top: this.top };
    }
    at(top: number): this {
      this.top = top;
      return this;
    }
    add(...children: FakeNode[]): this {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
      return this;
    }
    all(): FakeNode[] {
      return this.children.flatMap(child => [child, ...child.all()]);
    }
    /** The selectors the page uses: its controls, `details`, the composer and its chips. */
    matches(selector: string): boolean {
      if (selector.includes("data-journal-composer")) return this.attributes.composer === "true";
      if (selector.startsWith("input[name=\"kind\"]")) return this.tag === "input" && this.attributes.name === "kind";
      if (selector === "details") return this.tag === "details";
      if (selector === "details:not([open])") return this.tag === "details" && !this.open;
      if (selector === "section[id]") return this.tag === "section" && this.id !== "";
      if (selector === "summary") return this.tag === "summary";
      if (selector === "form") return this.tag === "form";
      return ["input", "select", "textarea", "button"].includes(this.tag);
    }
    querySelectorAll(selector: string): FakeNode[] {
      return this.all().filter(node => node.matches(selector));
    }
    querySelector(selector: string): FakeNode | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    closest(selector: string): FakeNode | null {
      for (let node: FakeNode | null = this; node; node = node.parent) if (node.matches(selector)) return node;
      return null;
    }
    contains(other: FakeNode): boolean {
      for (let node: FakeNode | null = other; node; node = node.parent) if (node === this) return true;
      return false;
    }
  }

  function stubPage(...nodes: FakeNode[]) {
    const root = new FakeNode("body").add(...nodes);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("document", {
      getElementById: (id: string) => root.all().find(node => node.id === id) ?? null,
      querySelector: (selector: string) => root.querySelector(selector),
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  it("knows every target a link can name, and nothing else", () => {
    const targets = Object.values(TRADE_TARGETS);
    expect(targets.map(target => tradeTargetOf(`#${target}`))).toEqual(targets);
    expect(tradeTargetOf("close-trade")).toBe("close-trade");
    for (const hash of ["", "#", "#Close-trade", "#journal-composer", "#review-heading", "#close-trade?x"]) expect(tradeTargetOf(hash), hash).toBeNull();
  });

  it("scrolls to a target and focuses its first control, without motion when reduced motion is asked for", () => {
    const price = new FakeNode("input");
    // The close form opens the "Close trade" section: the section scrolls into view, so its heading stays visible.
    const target = new FakeNode("div", TRADE_TARGETS.closeTrade).at(1288).add(new FakeNode("form").add(price, new FakeNode("button")));
    const section = new FakeNode("section", "result").at(1200).add(target);
    stubPage(section);
    expect(revealTradeTarget("close-trade")).toBe(true);
    expect(section.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(price.focus).toHaveBeenCalledWith({ preventScroll: true });
    // A form further down its section (entry details under the recorded facts) scrolls itself.
    const detailsInput = new FakeNode("input");
    const details = new FakeNode("div", TRADE_TARGETS.entryDetails).at(1500).add(detailsInput);
    stubPage(new FakeNode("section", "execution").at(1200).add(new FakeNode("dl"), details));
    expect(revealTradeTarget("entry-details")).toBe(true);
    expect(details.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(detailsInput.focus).toHaveBeenCalledTimes(1);
    // A target of another state of the trade (the trade was closed meanwhile) is left alone.
    expect(revealTradeTarget("record-entry")).toBe(false);
  });

  it("opens a collapsed panel to reach the first control, and skips controls hidden in one when a visible one exists", () => {
    const grade = new FakeNode("input");
    const panel = new FakeNode("details").add(new FakeNode("summary"), new FakeNode("form").add(grade));
    const review = new FakeNode("section", TRADE_TARGETS.review).add(panel);
    stubPage(review);
    expect(revealTradeTarget("review")).toBe(true);
    expect(panel.open).toBe(true);
    expect(grade.focus).toHaveBeenCalledTimes(1);

    const hidden = new FakeNode("input");
    const shown = new FakeNode("button");
    const evidence = new FakeNode("section", TRADE_TARGETS.evidence).add(new FakeNode("details").add(hidden), shown);
    stubPage(evidence);
    expect(reveal("evidence")).toBe(true);
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(shown.focus).toHaveBeenCalledTimes(1);
  });

  it("focuses the composer for #journal, and for #add-screenshots once screenshots go through it; opens Technical details", () => {
    const composer = new FakeNode("textarea", "journal-composer", { composer: "true" });
    stubPage(new FakeNode("section", TRADE_TARGETS.journal).add(new FakeNode("form").add(new FakeNode("input", "", { name: "kind" }), composer)));
    expect(revealTradeTarget("journal")).toBe(true);
    expect(revealTradeTarget("add-screenshots")).toBe(true);
    expect(composer.focus).toHaveBeenCalledTimes(2);

    const stagerInput = new FakeNode("input");
    stubPage(new FakeNode("div", TRADE_TARGETS.addScreenshots).add(stagerInput), new FakeNode("section", TRADE_TARGETS.journal).add(new FakeNode("form").add(composer)));
    expect(revealTradeTarget("add-screenshots")).toBe(true);
    expect(stagerInput.focus).toHaveBeenCalledTimes(1);

    const summary = new FakeNode("summary");
    const disclosure = new FakeNode("details").add(summary);
    stubPage(new FakeNode("section", TRADE_TARGETS.technical).add(disclosure));
    expect(revealTradeTarget("technical-details")).toBe(true);
    expect(disclosure.open).toBe(true);
    expect(summary.focus).toHaveBeenCalledTimes(1);
  });
});

describe("execution and outcome (§3.5, §8.5)", () => {
  it("prefills the entry at the tick and step scale", () => {
    expect(entryDefaults(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" })))).toEqual({ entry: "1.10000", quantity: "0.25" });
    expect(entryDefaults(detail(ledger({ ...LIVE_FIRST })))).toEqual({ entry: "", quantity: "" });
  });

  it("shows when an entry was recorded long after it happened", () => {
    expect(entryLine(detail(ledger(LIVE)), NOW, STRATEGY_TIME)).toBe("Entered 03:05 · 1.10000 · 0.25 lots");
    expect(entryLine(detail(ledger({ ...LIVE, entry_recorded_at: "2026-10-23T08:20:00Z" })), NOW, STRATEGY_TIME)).toBe("Entered 03:05 · recorded 03:20 · 1.10000 · 0.25 lots");
  });

  it("lists what a live-first position still misses and how it will close", () => {
    const bare = detail(ledger({ ...LIVE_FIRST, instrument_version_id: null, entry_model: null }), { instrument: null });
    expect(missingEntryFields(bare)).toEqual(["instrumentId", "entryModel", "entryPrice", "quantity", "initialStop", "riskAmount"]);
    expect(closeMode(bare)).toEqual({ kind: "reported", missing: ["the instrument contract", "the entry price", "the size"] });
    expect(listInWords(["the instrument contract", "the entry price", "the size"])).toBe("the instrument contract, the entry price and the size");
    expect(riskBasisPreview(bare)).toContain("realized R won't be available");
    const known = detail(ledger({ ...LIVE_FIRST, entry_price: "1.16074", quantity: "2.5", initial_stop: "1.16224", initial_risk: "375", entry_model: "OTHER" }));
    expect(missingEntryFields(known)).toEqual([]);
    expect(closeMode(known)).toEqual({ kind: "calculated" });
    expect(riskBasisPreview(known)).toBe("R based on risk recorded after entry: realized R = net P&L ÷ $375.00.");
    expect(closeMode(detail(ledger(LIVE)))).toEqual({ kind: "planned" });
    expect(riskBasisPreview(detail(ledger(LIVE)))).toBe("R based on locked risk: realized R = net P&L ÷ $500.00.");
    expect(missingEntryFields(detail(ledger(LIVE)))).toEqual([]);
  });

  it("states a live-first position's facts in words and what is not recorded", () => {
    const facts = positionFacts(detail(ledger({ ...LIVE_FIRST, instrument_version_id: null, entry_price: "23476.1", entry_model: null }), {
      instrument: null, close: { riskBasisSource: "USER_REPORTED" },
    }), NOW, STRATEGY_TIME);
    expect(facts.map(fact => [fact.label, fact.value])).toEqual([
      ["Instrument", "EURUSD · Long"], ["Model", null], ["Entry", "23476.1"], ["Entry time", "13:05"], ["Size", null], ["Initial stop", null], ["Risk at stop", null],
    ]);
    expect(facts[0].hint).toBe("No contract values");
  });

  it("leads with the stop the journal moved it to while live, and keeps the recorded stop as the initial stop (§3.6)", () => {
    const DE40 = { ...EURUSD, symbol: "DE40", currency: "EUR", tickSize: "0.1", quantityUnit: "contracts", quantityStep: "0.01" };
    const stopChange = (id: string, price: string, recordedAt: string, timing: Timing) => record(id, "JOURNAL", recordedAt, timing, { journalKind: "STOP_CHANGE", details: { price } });
    const timeline = [
      // A stop journaled before the entry (an older row) and one after the close never describe the open position.
      stopChange("journal:early", "23400.5", "2026-10-23T18:06:00Z", "BEFORE_ENTRY"),
      stopChange("journal:moved", "23426.5", "2026-10-23T18:30:00Z", "WHILE_LIVE"),
      stopChange("journal:newest", "23432.5", "2026-10-23T18:45:00Z", "WHILE_LIVE"),
      stopChange("journal:after", "23440", "2026-10-23T18:50:00Z", "AFTER_CLOSE"),
      record("journal:note", "JOURNAL", "2026-10-23T18:55:00Z", "WHILE_LIVE", { journalKind: "NOTE", details: { price: "1" } }),
    ];
    const live = ledger({
      ...LIVE_FIRST, symbol: "DE40", currency: "EUR", entry_price: "23454.5", quantity: "1.85", initial_stop: "23426.5", initial_risk: "51.8", entry_model: "OB_FIRST_TOUCH",
    });
    expect(liveStopMove(timeline)).toEqual({ price: "23432.5", recordedAt: "2026-10-23T18:45:00Z" });
    const facts = positionFacts(detail(live, { instrument: DE40, timeline }), NOW, STRATEGY_TIME);
    expect(facts.map(fact => [fact.label, fact.value, fact.hint ?? null]).slice(4)).toEqual([
      ["Size", "1.85 contracts", null], ["Stop", "23432.5", "Moved 13:45"], ["Initial stop", "23426.5", null], ["Risk at stop", "€51.80", null],
    ]);
    // A stop moved to the entry says so, as Today's live card does.
    const breakEven = [...timeline, stopChange("journal:be", "23454.5", "2026-10-23T18:58:00Z", "WHILE_LIVE")];
    expect(positionFacts(detail(live, { instrument: DE40, timeline: breakEven }), NOW, STRATEGY_TIME).find(fact => fact.label === "Stop"))
      .toEqual({ label: "Stop", value: "23454.5", hint: "At entry · moved 13:58" });
    // Without a move, and once the position is closed, only the initial stop is stated.
    expect(positionFacts(detail(live, { instrument: DE40, timeline: timeline.filter(item => item.timing !== "WHILE_LIVE") }), NOW, STRATEGY_TIME).map(fact => fact.label))
      .not.toContain("Stop");
    const closed = ledger({ ...LIVE_FIRST, symbol: "DE40", initial_stop: "23426.5", exited_at: "2026-10-23T18:59:00Z", net_pnl: "-20", outcome: "LOSS", lifecycle: "CLOSED" });
    expect(positionFacts(detail(closed, { instrument: DE40, timeline }), NOW, STRATEGY_TIME).map(fact => fact.label)).not.toContain("Stop");
  });

  it("says which entry details were added after the position was recorded, and when (§3.5)", () => {
    const records = [
      { recordedAt: "2026-10-23T18:10:00Z", details: ["entryPrice", "enteredAt"] as const },
      { recordedAt: "2026-10-23T18:20:00Z", details: ["quantity", "initialStop", "riskAmount"] as const },
      // A detail is never set twice; a repeat in a later record changes nothing.
      { recordedAt: "2026-10-23T18:30:00Z", details: ["quantity", "contract"] as const },
    ];
    expect(addedLater(records)).toEqual({ quantity: "2026-10-23T18:20:00Z", initialStop: "2026-10-23T18:20:00Z", riskAmount: "2026-10-23T18:20:00Z", contract: "2026-10-23T18:30:00Z" });
    const trade = detail(ledger({ ...LIVE_FIRST, symbol: "DE40", entry_price: "23476.1", quantity: "2.2", initial_stop: "23500.1", initial_risk: "51.8", entry_model: null }), {
      instrument: { ...EURUSD, symbol: "DE40", currency: "EUR", tickSize: "0.1", quantityUnit: "contracts", quantityStep: "0.1" },
    });
    const facts = positionFacts(trade, NOW, STRATEGY_TIME, records);
    expect(facts.map(fact => [fact.label, fact.hint ?? null])).toEqual([
      ["Instrument", "Contract added 13:30"], ["Model", null], ["Entry", null], ["Entry time", null], ["Size", "Added 13:20"], ["Initial stop", "Added 13:20"],
      ["Risk at stop", "Risk amount you recorded · added 13:20"],
    ]);
    expect(positionRecordedLine(records, NOW, STRATEGY_TIME)).toBe("Recorded 13:10, with the position already open. Details marked “Added” were completed later.");
    expect(positionRecordedLine(records.slice(0, 1), NOW, STRATEGY_TIME)).toBe("Recorded 13:10, with the position already open.");
    expect(positionRecordedLine([], NOW, STRATEGY_TIME)).toBeNull();
    // Recorded with the position: no "added" hints, and the derived risk keeps its own words after the close.
    const closed = ledger({
      ...LIVE_FIRST, initial_risk: "375", exited_at: "2026-10-23T18:48:00Z", close_recorded_at: "2026-10-23T18:49:00Z", net_pnl: "-295", realized_r: "-0.78666666",
      outcome: "LOSS", lifecycle: "CLOSED",
    });
    const derived = positionFacts(detail(closed, { close: { riskBasisSource: "DERIVED" } }), NOW, STRATEGY_TIME, records.slice(0, 1));
    expect(derived.map(fact => fact.hint ?? null)).toEqual([null, null, null, null, null, null, "From the recorded entry, stop and size"]);
  });

  it("keeps tags and lessons editable after the review, and says so", () => {
    const reviewed = detail(ledger({ ...CLOSED, lifecycle: "REVIEWED", review_completed_at: "2026-10-23T18:50:00Z" }));
    expect(nextStepHint(reviewed, NOW, STRATEGY_TIME)).toEqual({ tone: "neutral", text: "Reviewed 13:50. Tags and lessons stay editable; reopen the review to mark it pending again." });
  });

  it("explains the calculation basis of realized R", () => {
    const planned = outcomeView(detail(ledger(CLOSED)), NOW, STRATEGY_TIME);
    expect(planned?.basis).toBe("R based on locked risk · realized R = net P&L ÷ $500.00");
    expect(planned?.facts.map(fact => [fact.label, fact.value, fact.hint ?? null])).toEqual([
      ["Average exit price", "1.10612", null], ["Exit time", "05:50", "Recorded 13:44"], ["Held", "2h 45m", null], ["Gross P&L", "+$1,537.00", null], ["Fees", "$7.00", null],
    ]);
    const liveFirst = outcomeView(detail(ledger({ ...LIVE_FIRST, ...{ exit_price: "1.16186", exited_at: "2026-10-23T18:48:00Z", close_recorded_at: "2026-10-23T18:49:00Z", net_pnl: "-295", gross_pnl: "-280", fees: "15", realized_r: "-0.78666666", outcome: "LOSS", pnl_source: "CALCULATED", initial_risk: "375", lifecycle: "CLOSED" } }), {
      close: { riskBasisSource: "DERIVED" },
    }), NOW, STRATEGY_TIME);
    expect(liveFirst?.basis).toBe("R based on risk recorded after entry · realized R = net P&L ÷ $375.00 (from the recorded entry, stop and size)");
    expect(liveFirst?.summary.r).toBe("-0.79R");
    expect(liveFirst?.facts.at(-1)).toEqual({ label: "P&L source", value: "Calculated from the recorded prices and size" });
    const withoutRisk = outcomeView(detail(ledger({ ...LIVE_FIRST, exited_at: "2026-10-23T18:48:00Z", net_pnl: "102.47", outcome: "WIN", pnl_source: "USER_REPORTED", lifecycle: "CLOSED" })), NOW, STRATEGY_TIME);
    expect(withoutRisk?.basis).toBe("No risk was recorded, so realized R is not available.");
  });

  it("finds the lessons among the journal entries", () => {
    const item = (id: string, journalKind?: TimelineItem["journalKind"]): TimelineItem => ({
      id, kind: journalKind ? "JOURNAL" : "NOTE", journalKind, at: NOW, recordedAt: NOW, timing: "AFTER_CLOSE", flags: [], title: "", source: id, timeLabel: "",
    });
    expect(lessonsOf([item("a", "NOTE"), item("b", "LESSON"), item("c"), item("d", "LESSON")]).map(entry => entry.id)).toEqual(["b", "d"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Forms: client checks mirror the actions and the database
// ---------------------------------------------------------------------------------------------------------------------
describe("times in the person's display (§5.1)", () => {
  it("turns a wall-clock time into an instant with an explicit zone and back", () => {
    expect(instantOfWallClock("2026-10-23T09:42", STRATEGY_TIME)).toBe("2026-10-23T14:42:00.000Z");
    expect(instantOfWallClock("2026-10-23T09:42", { mode: "utc" })).toBe("2026-10-23T09:42:00.000Z");
    expect(instantOfWallClock("2026-07-01T09:42", { mode: "local", zone: "Europe/Kyiv" })).toBe("2026-07-01T06:42:00.000Z");
    expect(instantOfWallClock("2026-01-15T09:42", { mode: "local", zone: "Europe/Kyiv" })).toBe("2026-01-15T07:42:00.000Z");
    expect(wallClockOf("2026-10-23T14:42:00Z", STRATEGY_TIME)).toBe("2026-10-23T09:42");
    expect(wallClockOf("2026-10-23T14:42:00Z", { mode: "local", zone: "Europe/Kyiv" })).toBe("2026-10-23T17:42");
    for (const invalid of ["2026-02-30T10:00", "2026-10-23T24:00", "2026-10-23", "09:42", ""]) expect(instantOfWallClock(invalid, STRATEGY_TIME)).toBeNull();
    expect(instantOfWallClock("2026-10-23T09:42", { mode: "local", zone: "Not/AZone" })).toBeNull();
    expect(zoneHint(STRATEGY_TIME)).toBe("UTC−5 (strategy time)");
    expect(zoneHint({ mode: "utc" })).toBe("UTC");
  });

  it("sends now as the server's now, and checks earlier times against their bounds", () => {
    expect(resolveTime({ mode: "now" }, STRATEGY_TIME)).toEqual({ ok: true, value: "now" });
    expect(resolveTime({ mode: "earlier", wall: "" }, STRATEGY_TIME)).toEqual({ ok: false, error: FORM_COPY.time });
    const bound = { instant: "2026-10-23T12:52:00Z", message: "After the lock." };
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:51" }, STRATEGY_TIME, { notBefore: bound })).toEqual({ ok: false, error: "After the lock." });
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:52" }, STRATEGY_TIME, { notBefore: bound })).toEqual({ ok: true, value: "2026-10-23T12:52:00.000Z" });
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:53" }, STRATEGY_TIME, { notAfter: bound })).toEqual({ ok: false, error: "After the lock." });
  });

  it("reads a time typed in the bound's own minute as the bound itself, never as a refusal", () => {
    // Locked at 07:52:27 UTC−5: an entry typed as 07:52 happened after the lock within that minute.
    const lock = { instant: "2026-10-23T12:52:27.123456+00:00", message: "After the lock." };
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:52" }, STRATEGY_TIME, { notBefore: lock })).toEqual({ ok: true, value: "2026-10-23T12:52:27.123456+00:00" });
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:51" }, STRATEGY_TIME, { notBefore: lock })).toEqual({ ok: false, error: "After the lock." });
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:53" }, STRATEGY_TIME, { notBefore: lock })).toEqual({ ok: true, value: "2026-10-23T12:53:00.000Z" });
    // An upper bound in the same minute keeps the typed minute (its start is not later than the bound).
    expect(resolveTime({ mode: "earlier", wall: "2026-10-23T07:52" }, STRATEGY_TIME, { notAfter: lock })).toEqual({ ok: true, value: "2026-10-23T12:52:00.000Z" });
    const entry = { instant: new Date("2026-10-23T13:05:40.000Z"), message: "After the entry." };
    expect(validateClose({ exit: "1.1", netPnl: "", pnlKind: null, fees: "", time: { mode: "earlier", wall: "2026-10-23T08:05" } }, { mode: "planned", tickSize: "0.00001", display: STRATEGY_TIME, enteredAt: entry }))
      .toEqual({ ok: true, fields: { exitedAt: "2026-10-23T13:05:40.000Z", exit: "1.1", fees: "0" } });
  });
});

describe("record entry (§8.5)", () => {
  const context = { tickSize: "0.00001", quantityStep: "0.01", plannedQuantity: "0.25", display: STRATEGY_TIME, lockedAt: null };

  it("records the fill with the server's now and refuses values the database would refuse", () => {
    expect(validateEntry({ entry: "1.10002", quantity: "0.25", time: { mode: "now" }, confirmOversize: false }, context))
      .toEqual({ ok: true, fields: { entry: "1.10002", quantity: "0.25", enteredAt: "now" } });
    expect(validateEntry({ entry: "", quantity: "abc", time: { mode: "now" }, confirmOversize: false }, context))
      .toEqual({ ok: false, fieldErrors: { entry: FORM_COPY.entryRequired, quantity: FORM_COPY.quantity } });
    expect(validateEntry({ entry: "1.100005", quantity: "0.255", time: { mode: "now" }, confirmOversize: false }, context))
      .toEqual({ ok: false, fieldErrors: { entry: "Prices must be a multiple of the 0.00001 tick size.", quantity: "Size must be a multiple of the 0.01 size step." } });
    expect(validateEntry({ entry: "0", quantity: "1.123456789", time: { mode: "now" }, confirmOversize: false }, context).ok).toBe(false);
  });

  it("requires the confirmation of a size above the plan, with the exact deviation sentence", () => {
    expect(oversizeWarning("0.5", "0.25", "0.01")).toBe("Actual size 0.50 exceeds the plan's 0.25 (2.00×). This will be recorded as a size deviation.");
    expect(oversizeWarning("0.25", "0.25", "0.01")).toBeNull();
    expect(oversizeWarning("0.2", "0.25", "0.01")).toBeNull();
    expect(oversizeWarning("not a number", "0.25", "0.01")).toBeNull();
    expect(validateEntry({ entry: "1.1", quantity: "0.5", time: { mode: "now" }, confirmOversize: false }, context))
      .toEqual({ ok: false, fieldErrors: { confirmOversize: FORM_COPY.oversize } });
    expect(validateEntry({ entry: "1.1", quantity: "0.5", time: { mode: "now" }, confirmOversize: true }, context))
      .toEqual({ ok: true, fields: { entry: "1.1", quantity: "0.5", enteredAt: "now", confirmOversize: "on" } });
  });

  it("refuses an earlier entry time before the lock", () => {
    const locked = { ...context, lockedAt: { instant: "2026-10-23T12:52:00Z", message: "The entry time must be after the plan was locked (07:52)." } };
    expect(validateEntry({ entry: "1.1", quantity: "0.25", time: { mode: "earlier", wall: "2026-10-23T07:30" }, confirmOversize: false }, locked))
      .toEqual({ ok: false, fieldErrors: { enteredAt: "The entry time must be after the plan was locked (07:52)." } });
    expect(validateEntry({ entry: "1.1", quantity: "0.25", time: { mode: "earlier", wall: "2026-10-23T08:05" }, confirmOversize: false }, locked))
      .toEqual({ ok: true, fields: { entry: "1.1", quantity: "0.25", enteredAt: "2026-10-23T13:05:00.000Z" } });
  });

  it("checks alignment only when the contract is known", () => {
    expect(isAligned("1.100005", null)).toBe(true);
    expect(isAligned("23476.1", "0.1")).toBe(true);
    expect(isAligned("23476.15", "0.1")).toBe(false);
  });
});

describe("close trade (§3.4–3.5)", () => {
  const base = { exit: "", netPnl: "", pnlKind: null, fees: "", time: { mode: "now" } } as const;
  const context = (mode: "planned" | "calculated" | "reported") => ({ mode, tickSize: mode === "reported" ? null : "0.00001", display: STRATEGY_TIME, enteredAt: null });

  it("closes a planned trade with one exit, the time and fees (zero when empty)", () => {
    expect(validateClose({ ...base, exit: "1.10612" }, context("planned"))).toEqual({ ok: true, fields: { exitedAt: "now", exit: "1.10612", fees: "0" } });
    expect(validateClose({ ...base, exit: "1.10612", fees: "7.5" }, context("planned"))).toEqual({ ok: true, fields: { exitedAt: "now", exit: "1.10612", fees: "7.5" } });
    expect(validateClose({ ...base, fees: "7.555" }, context("planned"))).toEqual({ ok: false, fieldErrors: { exit: FORM_COPY.exitRequired, fees: FORM_COPY.fees } });
    expect(validateClose({ ...base, exit: "1.106125" }, context("planned"))).toEqual({ ok: false, fieldErrors: { exit: "Prices must be a multiple of the 0.00001 tick size." } });
  });

  it("sends a live-first exit price for calculation and never a net P&L then", () => {
    expect(validateClose({ ...base, exit: "1.16186", netPnl: "10", pnlKind: "profit" }, context("calculated"))).toEqual({ ok: true, fields: { exitedAt: "now", exitPrice: "1.16186" } });
  });

  it("asks for the reported net P&L with an explicit sign when it can't be calculated", () => {
    expect(validateClose(base, context("reported"))).toEqual({ ok: false, fieldErrors: { pnlKind: FORM_COPY.pnlKind } });
    expect(validateClose({ ...base, pnlKind: "loss" }, context("reported"))).toEqual({ ok: false, fieldErrors: { netPnl: FORM_COPY.netPnlRequired } });
    expect(validateClose({ ...base, pnlKind: "loss", netPnl: "-295" }, context("reported"))).toEqual({ ok: false, fieldErrors: { netPnl: FORM_COPY.netPnl } });
    expect(validateClose({ ...base, pnlKind: "profit", netPnl: "0" }, context("reported"))).toEqual({ ok: false, fieldErrors: { netPnl: FORM_COPY.netPnlZero } });
    expect(validateClose({ ...base, pnlKind: "loss", netPnl: "295.5", fees: "4" }, context("reported"))).toEqual({ ok: true, fields: { exitedAt: "now", fees: "4", netPnl: "-295.5" } });
    expect(validateClose({ ...base, pnlKind: "breakeven", exit: "3318.61" }, context("reported"))).toEqual({ ok: true, fields: { exitedAt: "now", exitPrice: "3318.61", netPnl: "0" } });
    expect(signedPnl("profit", "102.47")).toBe("102.47");
    expect(closeFieldOf("exitPrice")).toBe("exit");
    expect(closeFieldOf("pnlKind")).toBe("pnlKind");
    expect(closeFieldOf("tradeId")).toBeNull();
  });

  it("refuses an exit before the entry", () => {
    const bounded = { ...context("planned"), enteredAt: { instant: "2026-10-23T13:05:00Z", message: "The exit time must be after the entry (08:05)." } };
    expect(validateClose({ ...base, exit: "1.1", time: { mode: "earlier", wall: "2026-10-23T08:00" } }, bounded))
      .toEqual({ ok: false, fieldErrors: { exitedAt: "The exit time must be after the entry (08:05)." } });
  });
});

describe("live-first entry details (§3.5)", () => {
  const context = { fields: ["entryModel", "quantity", "initialStop", "riskAmount", "enteredAt"] as const, tickSize: "0.1", quantityStep: "0.01", display: STRATEGY_TIME, recordedAt: { instant: "2026-10-23T18:10:00Z", message: "Not after 13:10." } };

  it("sends only the details that are missing and filled", () => {
    expect(validateEntryDetails({ ...EMPTY_DETAILS, initialStop: "23500.1", riskAmount: "51.8", entryPrice: "1" }, { ...context, fields: [...context.fields] }))
      .toEqual({ ok: true, fields: { initialStop: "23500.1", riskAmount: "51.8" } });
    expect(validateEntryDetails(EMPTY_DETAILS, { ...context, fields: [...context.fields] })).toEqual({ ok: false, fieldErrors: {}, message: FORM_COPY.nothing });
  });

  it("refuses off-tick prices, risk with more than two decimals and an entry after the recording", () => {
    expect(validateEntryDetails({ ...EMPTY_DETAILS, initialStop: "23500.15", riskAmount: "51.875", enteredAt: "2026-10-23T13:30" }, { ...context, fields: [...context.fields] }))
      .toEqual({ ok: false, fieldErrors: { initialStop: "Prices must be a multiple of the 0.1 tick size.", riskAmount: FORM_COPY.riskAmount, enteredAt: "Not after 13:10." } });
    expect(validateEntryDetails({ ...EMPTY_DETAILS, enteredAt: "2026-10-23T13:05", entryModel: "OTE" }, { ...context, fields: [...context.fields] }))
      .toEqual({ ok: true, fields: { entryModel: "OTE", enteredAt: "2026-10-23T18:05:00.000Z" } });
  });
});

describe("tags (§3.8)", () => {
  it("normalizes and limits tags like the server", () => {
    expect(normalizeTag("  New   York ")).toBe("new york");
    expect(addTags(["london"], "Sweep, a-setup ,london")).toEqual({ ok: true, tags: ["london", "sweep", "a-setup"] });
    expect(addTags([], "no!")).toEqual({ ok: false, error: FORM_COPY.tag });
    expect(addTags(Array.from({ length: MAX_TAGS }, (_, index) => `t${index}`), "one-more")).toEqual({ ok: false, error: FORM_COPY.tagLimit });
    expect(addTags(["a"], " , ")).toEqual({ ok: true, tags: ["a"] });
    expect(sameTags({ grade: "A", liquidity: null, mss: "M5", tags: ["b", "a"] }, { grade: "A", liquidity: null, mss: "M5", tags: ["a", "b"] })).toBe(true);
    expect(sameTags({ grade: "A", liquidity: null, mss: "M5", tags: ["a"] }, { grade: "B", liquidity: null, mss: "M5", tags: ["a"] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Forms' first render
// ---------------------------------------------------------------------------------------------------------------------
describe("forms render", () => {
  it("prefills the record-entry form and shows the deviation confirmation for a size above the plan", () => {
    const props = {
      tradeId: uuid(1), defaults: { entry: "1.10000", quantity: "0.25" }, planned: { entry: "1.10000", quantity: "0.25", quantityExact: "0.25" },
      contract: { tickSize: "0.00001", quantityStep: "0.01", unit: "lots" }, locked: { at: "2026-10-23T12:52:00Z", label: "07:52" }, display: STRATEGY_TIME, nowIso: NOW,
    };
    const html = renderToStaticMarkup(createElement(RecordEntryForm, props));
    expect(html).toContain('value="1.10000"');
    expect(html).toContain("Size (lots)");
    expect(html).toContain("Plan 0.25 lots");
    expect(html).not.toContain("size deviation");
    const oversized = renderToStaticMarkup(createElement(RecordEntryForm, { ...props, defaults: { entry: "1.10000", quantity: "0.50" } }));
    expect(oversized).toContain("Actual size 0.50 exceeds the plan&#x27;s 0.25 (2.00×). This will be recorded as a size deviation.");
    expect(oversized).toContain("Record the size deviation");
  });

  it("labels the exit for all partials and asks for a signed result only when P&L can't be calculated", () => {
    const props = { tradeId: uuid(1), currency: "USD", tickSize: "0.00001", basis: "R based on locked risk.", entered: null, display: STRATEGY_TIME, nowIso: NOW };
    const planned = renderToStaticMarkup(createElement(CloseTradeForm, { ...props, mode: "planned" }));
    expect(planned).toContain("Average exit price (all partials)");
    expect(planned).not.toContain("Breakeven");
    const reported = renderToStaticMarkup(createElement(CloseTradeForm, { ...props, mode: "reported", missing: "the entry price and the size", tickSize: null }));
    expect(reported).toContain("P&amp;L can&#x27;t be calculated because the entry price and the size are not recorded.");
    expect(reported).toContain("Profit");
    expect(reported).toContain("Loss");
    expect(reported).toContain("Breakeven");
    expect(reported).toContain("(optional)");
  });

  it("asks only for missing entry details and points to Manage account without a contract", () => {
    const props = {
      tradeId: uuid(1), requestKey: uuid(2), symbol: "DE40", contract: { tickSize: null, quantityStep: null, unit: "" }, currency: "EUR",
      recorded: { at: "2026-10-23T18:10:00Z", label: "13:10" }, display: STRATEGY_TIME, manageInstrumentsHref: `/accounts/${ACCOUNT}/manage?tab=instruments`,
    };
    const withContract = renderToStaticMarkup(createElement(EntryDetailsForm, { ...props, fields: ["instrumentId", "riskAmount"], instruments: [{ id: uuid(9), label: "DE40 · tick 0.1 · contracts" }] }));
    expect(withContract).toContain("DE40 · tick 0.1 · contracts");
    expect(withContract).toContain("Risk amount");
    expect(withContract).not.toContain("Initial stop");
    const withoutContract = renderToStaticMarkup(createElement(EntryDetailsForm, { ...props, fields: ["instrumentId", "initialStop"], instruments: [] }));
    expect(withoutContract).toContain("This account has no DE40 contract");
    expect(withoutContract).toContain(`href="/accounts/${ACCOUNT}/manage?tab=instruments"`);
    expect(withoutContract).toContain("Initial stop");
  });

  it("shows tags carried over from an earlier version until they are saved here", () => {
    const html = renderToStaticMarkup(createElement(TagsForm, { tradeId: uuid(1), initial: { grade: "B", liquidity: "PDH", mss: "M15", tags: ["patience"] }, source: "V1" }));
    expect(html).toContain("These tags come from an earlier version of Trading OS.");
    expect(html).toContain("patience");
    expect(html).toContain("PDH · previous day high");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Save tags/);
  });

  it("shows the stepper for planned trades and the exact banner for live-first ones", () => {
    const planned = renderToStaticMarkup(createElement(TradeProgress, { detail: detail(ledger(LIVE)), now: NOW, display: STRATEGY_TIME }));
    expect(planned).toContain('aria-label="Trade progress"');
    expect(planned).toContain('aria-current="step"');
    const liveFirst = renderToStaticMarkup(createElement(TradeProgress, { detail: detail(ledger(LIVE_FIRST)), now: NOW, display: STRATEGY_TIME }));
    expect(liveFirst).toContain("No pre-trade plan was recorded before execution.");
    expect(liveFirst).not.toContain("Trade progress");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Server extras
// ---------------------------------------------------------------------------------------------------------------------
describe("trade extras loader", () => {
  const riskPlan = { id: uuid(20), version: "Risk Plan V1.1", maxRiskPercent: "0.75", defaultRiskPercent: "0.5", minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", maxDailyTrades: 2, dailyRiskCap: "2000", dailyLossCap: null };
  const workspace = {
    riskPlan, strategy: { id: uuid(21), version: "ICT V1.0", rules: { execution_models: ["OB_FIRST_TOUCH", "OTE"], minimum_rr: "3" } },
    usage: { plannedSlots: 1, unplannedTrades: 1, plannedRisk: "500.1", unplannedRisk: "437.82" },
    instruments: [{ id: uuid(30), symbol: "DE40", tickSize: "0.1", quantityUnit: "contracts (index)" }, { id: uuid(31), symbol: "EU50", tickSize: "1", quantityUnit: "contracts" }],
  };

  beforeEach(() => {
    m.workspace = workspace;
    m.workspaceError = null;
    m.rows = {};
    m.lists = {};
    m.failures = [];
  });

  it("gives a draft its strategy card and today's usage with an exact sum", async () => {
    const extras = await loadTradeExtras(detail(ledger()));
    expect(extras.strategy?.context).toBe("The strategy and the risk plan this draft is checked against today.");
    expect(extras.strategy?.card.subtitle).toBe("Risk Plan V1.1 · fixed UTC−5");
    expect(extras.lockUsage).toEqual({ slotsUsed: 2, maxDailyTrades: 2, riskUsed: "937.92", dailyRiskCap: "2000", dailyLossCap: null, valuesDay: null });
    expect(extras.instruments).toEqual([]);
    // The day of the account's latest values goes with it, so a stale-values block can tell they were confirmed since.
    m.workspace = { ...workspace, observation: { id: uuid(40), tradingDay: "2026-10-23" } };
    expect((await loadTradeExtras(detail(ledger()))).lockUsage?.valuesDay).toBe("2026-10-23");
  });

  it("offers a live-first position without a contract the account's contract of the same symbol", async () => {
    const extras = await loadTradeExtras(detail(ledger({ ...LIVE_FIRST, symbol: "DE40", instrument_version_id: null }), { instrument: null }));
    expect(extras.instruments).toEqual([{ id: uuid(30), label: "DE40 · tick 0.1 · contracts" }]);
    expect(extras.strategy).toBeNull();
  });

  it("describes a locked plan with the versions it was locked with", async () => {
    m.rows = { strategy_versions: { id: uuid(11), version: "ICT V1.0", rules: {} }, risk_plan_versions: { id: uuid(12), version: "Risk Plan V1.0" } };
    const extras = await loadTradeExtras(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" })));
    expect(extras.strategy?.context).toContain("this plan was locked with");
    expect(extras.strategy?.card.subtitle).toBe("Risk Plan V1.0 · fixed UTC−5");
    expect(extras.lockUsage).toBeNull();
  });

  it("reads the last revision of a draft that was never locked", async () => {
    m.rows = { setup_proposals: { id: uuid(2), instrument_version_id: uuid(3), proposal: { ...PROPOSAL, narrative: "Daily bias was bearish.", instrumentId: uuid(3) } } };
    const extras = await loadTradeExtras(detail(ledger({ lifecycle: "DISCARDED", draft_check: null, discarded_at: NOW })));
    expect(extras.lastProposal).toMatchObject({ narrative: "Daily bias was bearish.", entry: "1.1", news: "CLEAR", instrumentVersionId: uuid(3) });
  });

  it("degrades to empty extras on a failed read, logging a fixed event only", async () => {
    m.workspaceError = new Error("db down");
    const extras = await loadTradeExtras(detail(ledger()));
    expect(extras).toEqual({ strategy: null, lockUsage: null, instruments: [], lastProposal: null, positionRecords: [], contractUpdated: null, customModels: [] });
    expect(m.failures).toEqual(["data_read_failed"]);
  });

  it("says when a draft's contract was superseded by a newer version of its symbol, as Edit Draft judges it", async () => {
    // The workspace lists the latest version of each symbol (the pickers' list); the draft's EURUSD is uuid(3).
    const withEurusd = (id: string) => ({ ...workspace, instruments: [...workspace.instruments, { id, symbol: "EURUSD", tickSize: "0.00001", quantityUnit: "lots" }] });
    m.workspace = withEurusd(uuid(32));
    expect((await loadTradeExtras(detail(ledger()))).contractUpdated).toEqual({ symbol: "EURUSD" });
    m.workspace = withEurusd(uuid(3).toUpperCase());
    expect((await loadTradeExtras(detail(ledger()))).contractUpdated).toBeNull();
    // No current contract of the symbol: nothing to move to.
    m.workspace = workspace;
    expect((await loadTradeExtras(detail(ledger()))).contractUpdated).toBeNull();
    // Only drafts: a locked plan keeps the contract it was locked with.
    m.workspace = withEurusd(uuid(32));
    m.rows = { strategy_versions: { id: uuid(11), version: "ICT V1.0", rules: {} }, risk_plan_versions: { id: uuid(12), version: "Risk Plan V1.0" } };
    expect((await loadTradeExtras(detail(ledger({ ...LOCKED, lifecycle: "LOCKED" })))).contractUpdated).toBeNull();
  });

  it("reads which entry details each record of a live-first position set, oldest first", async () => {
    m.lists = {
      trade_position_facts: [
        { recorded_at: "2026-10-23T18:10:00Z", instrument_version_id: null, entry_model: null, entry_price: "23476.1", entered_at: "2026-10-23T18:05:00Z", quantity: null, initial_stop: null, risk_amount: null },
        { recorded_at: "2026-10-23T18:20:00Z", instrument_version_id: uuid(30), entry_model: "OTE", entry_price: null, entered_at: null, quantity: "2.2", initial_stop: "23500.1", risk_amount: "51.80" },
      ],
    };
    const extras = await loadTradeExtras(detail(ledger({ ...LIVE_FIRST, symbol: "DE40", instrument_version_id: null }), { instrument: null }));
    expect(extras.positionRecords).toEqual([
      { recordedAt: "2026-10-23T18:10:00Z", details: ["entryPrice", "enteredAt"] },
      { recordedAt: "2026-10-23T18:20:00Z", details: ["contract", "model", "quantity", "initialStop", "riskAmount"] },
    ]);
    expect(extras.instruments).toEqual([{ id: uuid(30), label: "DE40 · tick 0.1 · contracts" }]);
    // Planned trades keep their own extras and never read position records.
    expect((await loadTradeExtras(detail(ledger()))).positionRecords).toEqual([]);
    m.lists = {};
  });
});
