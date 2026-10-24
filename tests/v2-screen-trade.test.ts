import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Trade workspace (docs/V2_ARCHITECTURE.md §14.4, §2.3–2.5, §5.3, §8, §15): the page is rendered from its real server
// components with the loaders mocked (no database). Trade details are built with the real domain modules
// (deriveTradeState, buildTimeline, planVsReality), so state words, next actions and timing bands are the product's own.

const m = vi.hoisted(() => ({
  detail: null as unknown,
  extras: null as unknown,
  timeDisplay: { mode: "strategy" } as { mode: "strategy" | "utc" | "local"; zone?: string },
  developerMode: false,
  preTradeProps: [] as Record<string, unknown>[],
  reviewProps: [] as Record<string, unknown>[],
  link: null as unknown,
  linkError: null as unknown,
  schemaReady: true,
  queries: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/trades/x",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/trades", () => ({
  checkRisk: vi.fn(), lockPlan: vi.fn(), discardDraft: vi.fn(), duplicateDraft: vi.fn(), setDisposition: vi.fn(), reopenReview: vi.fn(), completeReview: vi.fn(),
  recordEntry: vi.fn(), closePlannedTrade: vi.fn(), closeLiveTrade: vi.fn(), completeLiveEntry: vi.fn(), setTags: vi.fn(), relabelEvidence: vi.fn(), removeEvidence: vi.fn(),
}));
vi.mock("@/app/actions/journal", () => ({ addJournalEntry: vi.fn() }));
vi.mock("@/lib/trades-data", () => ({ getTradeDetail: async () => m.detail }));
vi.mock("@/components/trade/workspace-data", () => ({ loadTradeExtras: async () => m.extras }));
vi.mock("@/lib/account-context", () => ({
  THEME_COOKIE: "tos_theme",
  getPreferences: async () => ({ theme: "system", timeDisplay: m.timeDisplay, developerMode: m.developerMode, sidebarCollapsed: false }),
  currentSession: async () => ({
    user: { id: USER },
    db: {
      from: (table: string) => {
        m.queries.push(table);
        const chain = {
          select: () => chain,
          eq: (column: string, value: string) => {
            m.queries.push(`${column}=${value}`);
            return chain;
          },
          maybeSingle: async () => ({ data: m.link, error: m.linkError }),
        };
        return chain;
      },
    },
  }),
}));
vi.mock("@/lib/schema-gate", () => ({ getSchemaStatus: async () => (m.schemaReady ? { ready: true, version: "2.0" } : { ready: false, reason: "MISSING", version: null }) }));
// The AI panels load their own data (tested in v2-ui-ai-panels); here they are stubs that show what the page gives them.
vi.mock("@/components/ai/pre-trade-ai-panel", () => ({
  PreTradeAiPanel: (props: Record<string, unknown>) => {
    m.preTradeProps.push(props);
    return createElement("section", { "data-stub": "pre-trade-ai" }, "AI tools");
  },
}));
vi.mock("@/components/ai/trade-review-ai-panel", () => ({
  TradeReviewAiPanel: (props: Record<string, unknown>) => {
    m.reviewProps.push(props);
    return createElement("section", { "data-stub": "trade-review-ai" }, "AI review");
  },
}));

import TradeLoading from "@/app/(app)/trades/[id]/loading";
import TradeNotFound from "@/app/(app)/trades/[id]/not-found";
import TradePage, { generateMetadata } from "@/app/(app)/trades/[id]/page";
import LegacyPlanNotFound from "@/app/journal/[id]/not-found";
import LegacyPlanPage from "@/app/journal/[id]/page";
import type { TradeExtras } from "@/components/trade/workspace-data";
import { formatR } from "@/domain/format";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { planVsReality } from "@/domain/plan-vs-reality";
import type { ExplainedIssue } from "@/domain/risk-explain";
import { STRATEGY_TIME } from "@/domain/time-display";
import { buildTimeline, groupByTiming, type TimelineEvidence, type TimelineJournalEntry, type TimelineRevision, type TimelineRiskCheck } from "@/domain/timeline";
import { deriveTradeState } from "@/domain/trade-state";
import type { CheckView, EvidenceItemView, ProposalView, TradeDetail } from "@/lib/trades-data";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------
const NOW = "2026-10-23T19:00:00.000Z"; // Fri Oct 23, 14:00 UTC−5
const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`OB_FIRST_TOUCH`, `LIVE_FIRST`, `RISK_LIMIT`, `BEFORE_ENTRY`): never in visible text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const STATE_WORDS = /\b(LIVE_FIRST|PLANNED|REVIEWED|DRAFT|BLOCKED|LOCKED|APPROVED|UNCHECKED|CLOSED|SKIPPED|CANCELLED|DISCARDED|WIN|LOSS)\b/;
const INTERNAL_WORDS = /\b(proposal|observation|setup_status|NOT_EVALUATED|MANUAL_OVERRIDE|manifest|reservation)\b/i;

const EURUSD = {
  symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 units)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01",
  minimumQuantity: "0.01",
} as const;

function ledger(n: number, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: uuid(n), account_id: ACCOUNT, origin: "PLANNED", created_at: "2026-10-23T12:00:00Z", currency: "USD", revision_count: 1, latest_revision: 1,
    latest_proposal_id: uuid(n + 500), entry_time_known: false, lifecycle: "DRAFT", draft_check: "UNCHECKED", tags: [], evidence_count: 0, journal_count: 0,
    ai_review_count: 0, symbol: "EURUSD", instrument_version_id: uuid(900), direction: "LONG", entry_model: "OB_FIRST_TOUCH", planned_entry: "1.1", planned_stop: "1.098",
    planned_target: "1.106", requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "500", ...changes,
  };
}

function issue(code: string, title: string, detail: string, severity: "BLOCK" | "WARN" = "BLOCK"): ExplainedIssue {
  return { code, title, detail, severity };
}

const RISK_LIMIT = issue("RISK_LIMIT", "Requested risk exceeds maximum", "Requested risk 1.25% exceeds your configured maximum of 0.75%.");
const MAX_TRADES = issue("MAX_TRADES", "Daily trade limit reached", "Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live).");
const DEAD_POOL = issue("DEAD_POOL", "Dead Pool", "Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00.");
const NEWS_UNKNOWN = issue("NEWS_UNKNOWN", "News not checked", "Economic news has not been checked.", "WARN");
const COSTS = issue("COSTS_UNKNOWN", "Costs not included", "Sizing uses the stop distance only; fees, gaps and slippage are not included.", "WARN");

function check(decision: "APPROVED" | "BLOCKED", recordedAt: string, revision: number | null, blocking: ExplainedIssue[] = [], warnings: ExplainedIssue[] = [], notes: ExplainedIssue[] = []): CheckView {
  return {
    recordedAt, decision, revision, explained: { decision, blocking, warnings, notes },
    statusLine: decision === "APPROVED" ? "Risk Engine · Approved" : `Risk Engine · Blocked — ${blocking[0]?.title ?? ""}`,
    calculations: { quantity: "0.25", nominalRisk: "500", plannedRR: "2.995", budget: "500", stopDistance: "0.002" },
  };
}

function proposal(changes: Partial<ProposalView> = {}): ProposalView {
  return {
    instrumentVersionId: uuid(900), direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.1", stop: "1.098", target: "1.106", riskPercent: "0.5",
    narrative: "London swept the Asian low, then an M5 MSS left a bullish order block. Invalidation: an M5 close below 1.09800.", contractConfirmed: true,
    news: "CLEAR", contradiction: false, ...changes,
  };
}

interface Scenario {
  trade: LedgerTrade;
  checkCurrent?: boolean;
  aiAvailable?: boolean;
  checks?: CheckView[];
  /** Revisions and stored checks as the timeline sees them (default: revision 1 at the trade's creation, no checks). */
  revisions?: TimelineRevision[];
  timelineChecks?: TimelineRiskCheck[];
  draftProposal?: ProposalView;
  planProposal?: ProposalView;
  journal?: TimelineJournalEntry[];
  evidence?: (TimelineEvidence & { kind: "V2" })[];
  disposition?: TradeDetail["disposition"];
  lifecycleEvents?: { id: string; event: "DRAFT_DISCARDED" | "REVIEW_COMPLETED" | "REVIEW_REOPENED"; reason: string | null; recordedAt: string }[];
  close?: Partial<NonNullable<TradeDetail["close"]>>;
  instrument?: TradeDetail["instrument"];
}

function evidenceView(item: TimelineEvidence & { kind: "V2" }, timing: EvidenceItemView["timing"]): EvidenceItemView {
  return {
    kind: "V2", src: `/api/evidence/${item.id}`, thumbSrc: `/api/evidence/${item.id}?variant=thumb`, id: item.id, name: "M5 chart", label: item.label,
    timeframe: item.timeframe, caption: item.caption ?? null, timing, timingLabel: timing === "BEFORE_ENTRY" ? "Before entry" : timing === "WHILE_LIVE" ? "While live" : "After close",
    flags: [], recordedAt: item.recordedAt, removedAt: item.removedAt ?? null, copiedFromRecordedAt: null, copied: false, originalFilename: "chart.png", mimeType: "image/png",
    width: 1600, height: 900, byteSize: 120000, relabelable: true, removable: true,
  };
}

function detailOf(s: Scenario): TradeDetail {
  const trade = s.trade;
  const instrument = s.instrument === undefined ? EURUSD : s.instrument;
  const checks = s.checks ?? [];
  const latestCheck = checks.at(-1) ?? null;
  const state = deriveTradeState(trade, {
    now: NOW, checkCurrent: s.checkCurrent ?? false, aiAvailable: s.aiAvailable ?? false,
    blockingReason: latestCheck?.decision === "BLOCKED" ? latestCheck.explained.blocking[0]?.detail : undefined,
  });
  const timeline = buildTimeline({
    trade,
    instrument,
    revisions: s.revisions ?? [{ proposalId: uuid(trade.revision_count + 700), revision: 1, createdAt: trade.created_at }],
    riskChecks: s.timelineChecks ?? [],
    journal: s.journal ?? [],
    evidence: s.evidence ?? [],
    disposition: s.disposition ? { status: s.disposition.status, reason: s.disposition.reason, recordedAt: s.disposition.recordedAt } : null,
    lifecycleEvents: s.lifecycleEvents ?? [],
  }, STRATEGY_TIME);
  const items = (s.evidence ?? []).map(item => evidenceView(item, timeline.find(entry => entry.evidenceId === item.id)?.timing ?? "BEFORE_ENTRY"));
  const planned = trade.origin === "PLANNED";
  const hasEntry = !planned || trade.entry_recorded_at !== null;
  return {
    tradeId: trade.id,
    href: `/trades/${trade.id}`,
    account: { id: ACCOUNT, name: "FTMO 100K", currency: trade.currency, status: "ACTIVE" },
    origin: trade.origin,
    title: [trade.symbol ?? "Trade", trade.direction === "LONG" ? "Long" : trade.direction === "SHORT" ? "Short" : null].filter(Boolean).join(" · "),
    symbol: trade.symbol,
    direction: trade.direction,
    model: trade.entry_model,
    createdAt: trade.created_at,
    duplicatedFromHref: trade.duplicated_from ? `/trades/${trade.duplicated_from}` : null,
    state,
    revisionCount: trade.revision_count,
    draft: state.lifecycle === "DRAFT"
      ? { revision: trade.latest_revision ?? 1, expectedRevision: trade.latest_revision ?? 1, createdAt: trade.created_at, proposal: s.draftProposal ?? proposal(), latestCheck, checkCurrent: state.checkCurrent }
      : null,
    plan: trade.plan_id && trade.locked_at
      ? {
        lockedAt: trade.locked_at, tradingDay: "2026-10-23", riskPlanVersion: trade.risk_plan_version, strategyVersion: trade.strategy_version, proposal: s.planProposal ?? proposal(),
        check: check("APPROVED", trade.locked_at, null, [], [NEWS_UNKNOWN], [COSTS]), nominalRisk: trade.planned_risk ?? "500",
        immutableNote: "Locked plans can't be edited. Later changes are recorded in the journal.",
      }
      : null,
    execution: hasEntry
      ? {
        entryPrice: trade.entry_price, enteredAt: trade.entered_at, recordedAt: trade.entry_recorded_at, quantity: trade.quantity, plannedQuantity: trade.planned_quantity,
        oversize: trade.oversize === true, initialStop: trade.initial_stop, initialRisk: trade.initial_risk, actualRisk: trade.actual_initial_risk,
      }
      : null,
    close: trade.exited_at
      ? {
        exitPrice: trade.exit_price, exitedAt: trade.exited_at, recordedAt: trade.close_recorded_at, fees: trade.fees, grossPnl: trade.gross_pnl, netPnl: trade.net_pnl,
        realizedR: trade.realized_r, outcome: trade.outcome, pnlSource: trade.pnl_source, riskBasisSource: null,
        basisLabel: trade.realized_r === null ? "No risk was recorded, so realized R is not available." : planned ? "R based on locked risk" : "R based on risk recorded after entry",
        ...s.close,
      }
      : null,
    disposition: s.disposition ?? null,
    planVsReality: planVsReality(trade, instrument ? { tickSize: instrument.tickSize, pipSize: instrument.pipSize, quantityStep: instrument.quantityStep, quantityUnit: instrument.quantityUnit } : null, {
      equity: "100000", maxRiskPercent: "0.75", minRR: "3",
    }),
    positionFacts: [],
    instrument,
    tags: { grade: trade.setup_grade, liquidity: trade.liquidity_context, mss: trade.mss_timeframe, tags: trade.tags, source: trade.tag_source },
    checks,
    timeline,
    timelineGroups: groupByTiming(timeline),
    timelineTruncated: false,
    evidence: { items, groups: [], activeCount: items.filter(item => item.removedAt === null).length, limit: 24 },
    evidenceIndex: Object.fromEntries(items.map(item => [item.id, { label: item.label, timeframe: item.timeframe }])),
    review: { completedAt: trade.review_completed_at },
    ai: { activity: { reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null }, history: null, available: s.aiAvailable ?? false },
    technical: {
      tradeId: trade.id, accountId: ACCOUNT, origin: trade.origin, planId: trade.plan_id, latestProposalId: trade.latest_proposal_id, proposalIds: [uuid(trade.revision_count + 700)],
      latestCheckEvaluationId: trade.latest_check_evaluation_id, strategyVersionId: trade.strategy_version_id, riskPlanVersionId: trade.risk_plan_version_id,
      instrumentVersionId: trade.instrument_version_id, duplicatedFrom: trade.duplicated_from, migratedFrom: trade.migrated_from,
      checks: checks.map((item, index) => ({ evaluationId: uuid(800 + index), recordedAt: item.recordedAt, report: { decision: item.decision, issues: [{ code: "RISK_LIMIT" }] } })),
      planReport: trade.plan_id ? { decision: "APPROVED", engineVersion: "1.1" } : null,
      evidence: (s.evidence ?? []).map(item => ({ id: item.id, kind: "V2" as const, sha256: "a".repeat(64), storagePath: `${USER}/${trade.id}/${item.id}`, captureMethod: "PASTE", copiedFrom: null, storedPhase: item.phase, stateAtCreation: "DRAFT" })),
      ledger: trade,
    },
  };
}

const EXTRAS: TradeExtras = { strategy: null, lockUsage: null, instruments: [], lastProposal: null, positionRecords: [] };

// Scenarios ------------------------------------------------------------------------------------------------------------
const LOCKED_FIELDS: Partial<LedgerTrade> = {
  plan_id: uuid(101), locked_at: "2026-10-23T07:52:00Z", draft_check: null, strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.1",
  strategy_version_id: uuid(301), risk_plan_version_id: uuid(302),
};

const blockedDraft = () => detailOf({
  trade: ledger(1, {
    symbol: "GBPUSD", revision_count: 2, latest_revision: 2, latest_check_decision: "BLOCKED", latest_check_at: "2026-10-23T18:44:30Z", draft_check: "BLOCKED",
    requested_risk_percent: "1.25", latest_check_evaluation_id: uuid(801),
  }),
  checks: [check("APPROVED", "2026-10-23T18:40:00Z", 1), check("BLOCKED", "2026-10-23T18:44:30Z", 2, [RISK_LIMIT, DEAD_POOL], [NEWS_UNKNOWN], [COSTS])],
  draftProposal: proposal({ riskPercent: "1.25", news: "UNKNOWN" }),
});

const readyDraft = (aiAvailable = true) => detailOf({
  trade: ledger(2, { latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T18:58:00Z", draft_check: "APPROVED" }),
  checkCurrent: true, aiAvailable,
  checks: [check("APPROVED", "2026-10-23T18:58:00Z", 1, [], [NEWS_UNKNOWN], [COSTS])],
  evidence: [{ kind: "V2", id: uuid(201), label: "PRE_ENTRY", timeframe: "M5", caption: "Sweep and MSS", phase: "PRE_ENTRY", recordedAt: "2026-10-23T18:50:00Z" }],
});

const staleDraft = () => detailOf({
  trade: ledger(3, { latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T14:00:00Z", draft_check: "APPROVED" }),
  checkCurrent: false,
  checks: [check("APPROVED", "2026-10-23T14:00:00Z", 1)],
});

const uncheckedDraft = () => detailOf({ trade: ledger(4, { duplicated_from: uuid(40) }) });

const locked = () => detailOf({ trade: ledger(5, { ...LOCKED_FIELDS, symbol: "XAUUSD", direction: "SHORT", lifecycle: "LOCKED", planned_quantity: "0.88" }) });

const plannedLive = () => detailOf({
  trade: ledger(6, {
    ...LOCKED_FIELDS, lifecycle: "LIVE", entered_at: "2026-10-23T08:05:00Z", entry_recorded_at: "2026-10-23T08:06:00Z", entry_price: "1.10002", quantity: "0.5",
    initial_risk: "500", actual_initial_risk: "1005", oversize: true, entry_time_known: true,
  }),
  journal: [
    { id: uuid(601), kind: "NOTE", body: "Filled in the OTE; H1 FVG overhead is the main risk.", details: {}, phase: "LIVE", recordedAt: "2026-10-23T08:20:00Z" },
    { id: uuid(602), kind: "STOP_CHANGE", body: "Stop to break-even.", details: { price: "1.1" }, phase: "LIVE", recordedAt: "2026-10-23T10:00:00Z" },
    // Written before the entry was recorded but after the reported entry time: flagged (spec §5.3).
    { id: uuid(603), kind: "NOTE", body: "Waiting for the retest.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-10-23T08:05:30Z" },
  ],
});

const liveFirst = (changes: Partial<LedgerTrade> = {}) => detailOf({
  trade: ledger(7, {
    origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_proposal_id: null, symbol: "DE40", currency: "EUR", direction: "SHORT", entry_model: null,
    instrument_version_id: null, planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null,
    planned_risk: null, lifecycle: "LIVE", draft_check: null, created_at: "2026-10-23T18:10:00Z", entered_at: "2026-10-23T18:05:00Z", entry_price: "23476.1", ...changes,
  }),
  instrument: null,
  journal: [{ id: uuid(701), kind: "NOTE", body: "Entered from the chart before planning.", details: {}, phase: "LIVE", recordedAt: "2026-10-23T18:11:00Z" }],
});

const closedPlanned = () => detailOf({
  trade: ledger(8, {
    ...LOCKED_FIELDS, lifecycle: "CLOSED", entered_at: "2026-10-23T08:05:00Z", entry_recorded_at: "2026-10-23T08:06:00Z", entry_price: "1.1", quantity: "0.25",
    initial_risk: "500", actual_initial_risk: "500", oversize: false, exit_price: "1.10612", exited_at: "2026-10-23T10:50:00Z", close_recorded_at: "2026-10-23T18:44:00Z",
    fees: "7", gross_pnl: "1537", net_pnl: "1530", realized_r: "3.06", outcome: "WIN", pnl_source: "CALCULATED", setup_grade: "A+", liquidity_context: "ARL_LOW",
    mss_timeframe: "M5", tags: ["london", "sweep"], tag_source: "V2",
  }),
  aiAvailable: true,
  journal: [{ id: uuid(801), kind: "LESSON", body: "Textbook London session: no interference.", details: {}, phase: "POST_TRADE", recordedAt: "2026-10-23T18:45:00Z" }],
  evidence: [{ kind: "V2", id: uuid(202), label: "EXIT", timeframe: "M5", caption: null, phase: "POST_TRADE", recordedAt: "2026-10-23T18:46:00Z" }],
});

const reviewedLiveFirstWithoutRisk = () => detailOf({
  trade: ledger(9, {
    origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_proposal_id: null, symbol: "XAUUSD", direction: "SHORT", entry_model: "OTE",
    instrument_version_id: null, planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null,
    planned_risk: null, lifecycle: "REVIEWED", draft_check: null, created_at: "2026-09-23T07:33:00Z", entered_at: "2026-09-23T07:24:00Z", entry_price: "3332.09",
    exit_price: "3318.61", exited_at: "2026-09-23T10:37:00Z", close_recorded_at: "2026-09-23T10:59:00Z", fees: "0", net_pnl: "102.47", outcome: "WIN",
    pnl_source: "USER_REPORTED", review_completed_at: "2026-09-24T03:59:00Z",
  }),
  instrument: null,
  lifecycleEvents: [{ id: uuid(901), event: "REVIEW_COMPLETED", reason: null, recordedAt: "2026-09-24T03:59:00Z" }],
});

const skipped = () => detailOf({
  trade: ledger(10, { ...LOCKED_FIELDS, lifecycle: "SKIPPED", disposition: "SKIPPED", disposition_reason: "Price never returned to the order block." }),
  disposition: { status: "SKIPPED", reason: "Price never returned to the order block.", recordedAt: "2026-10-23T09:55:00Z" },
});

const discarded = () => detailOf({
  trade: ledger(11, { lifecycle: "DISCARDED", draft_check: null, discarded_at: "2026-10-23T18:44:00Z", latest_check_decision: "BLOCKED", latest_check_at: "2026-10-20T21:40:00Z" }),
  checks: [check("BLOCKED", "2026-10-20T21:40:00Z", 1, [DEAD_POOL])],
  lifecycleEvents: [{ id: uuid(902), event: "DRAFT_DISCARDED", reason: "Setup is three days old.", recordedAt: "2026-10-23T18:44:00Z" }],
});

/** Skipped at 04:55 UTC−5; a lesson and a screenshot of where price went were recorded after the skip. */
const skippedWithHindsight = () => detailOf({
  trade: ledger(13, { ...LOCKED_FIELDS, lifecycle: "SKIPPED", disposition: "SKIPPED", disposition_reason: "Price never returned to the order block." }),
  disposition: { status: "SKIPPED", reason: "Price never returned to the order block.", recordedAt: "2026-10-23T09:55:00Z" },
  journal: [{ id: uuid(1301), kind: "LESSON", body: "Price ran to the target without a retest; the skip cost a winner.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-10-23T10:16:00Z" }],
  evidence: [
    { kind: "V2", id: uuid(1302), label: "HTF", timeframe: "H4", caption: "H4 FVG still open above", phase: "PRE_ENTRY", recordedAt: "2026-10-23T07:45:00Z" },
    { kind: "V2", id: uuid(1303), label: "PRE_ENTRY", timeframe: "M15", caption: "Where price went after the skip", phase: "PRE_ENTRY", recordedAt: "2026-10-23T10:16:30Z" },
  ],
});

/** Blocked by a check from yesterday's session (Thu Oct 22, 13:44 UTC−5). */
const blockedYesterday = () => detailOf({
  trade: ledger(14, {
    direction: "SHORT", latest_check_decision: "BLOCKED", latest_check_at: "2026-10-22T18:44:00Z", draft_check: "BLOCKED", latest_check_evaluation_id: uuid(1401),
    created_at: "2026-10-22T18:44:00Z",
  }),
  checks: [check("BLOCKED", "2026-10-22T18:44:00Z", 1, [MAX_TRADES, DEAD_POOL], [NEWS_UNKNOWN])],
});

// Rendering ------------------------------------------------------------------------------------------------------------
async function render(detail: TradeDetail, extras: TradeExtras = EXTRAS): Promise<string> {
  m.detail = detail;
  m.extras = extras;
  const element = (await TradePage({ params: Promise.resolve({ id: detail.tradeId }) })) as ReactElement;
  return renderToStaticMarkup(element);
}

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;| /g, " ");

/** Removes every Technical details disclosure, inner `<details>` included (they nest). */
function withoutTechnicalDetails(html: string): string {
  let out = html;
  for (;;) {
    const start = out.search(/<details[^>]*class="[^"]*technical-details[^"]*"/);
    if (start === -1) return out;
    let depth = 0;
    const tag = /<details\b|<\/details>/g;
    tag.lastIndex = start;
    let end = -1;
    for (let match = tag.exec(out); match; match = tag.exec(out)) {
      depth += match[0] === "</details>" ? -1 : 1;
      if (depth === 0) {
        end = match.index + match[0].length;
        break;
      }
    }
    if (end === -1) return out.slice(0, start);
    out = out.slice(0, start) + out.slice(end);
  }
}

/** What a reader gets: text plus the attributes that are read or shown (aria-label, title, alt, placeholder). */
function visibleText(html: string): string {
  const shown = withoutTechnicalDetails(html);
  const attributes = [...shown.matchAll(/\s(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1]);
  const text = shown.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<\/?(span|a|strong|em|b|time|abbr)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ");
  return decode([text, ...attributes].join(" ")).replace(/\s+/g, " ");
}

function expectClean(html: string) {
  const text = visibleText(html);
  expect(text).not.toMatch(UUID);
  expect(text).not.toMatch(ENUM);
  expect(text).not.toMatch(STATE_WORDS);
  expect(text).not.toMatch(INTERNAL_WORDS);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
}

const blocksOf = (html: string) => /data-blocks="([^"]+)"/.exec(html)?.[1];

/** Text of every primary-styled button or link: the page's next action (and the commit of a form shown below it). */
function primaryButtonLabels(html: string): string[] {
  return [...html.matchAll(/<(button|a)\b[^>]*class="[^"]*btn-primary[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)].map(match => decode(match[2].replace(/<[^>]+>/g, "")).trim());
}

/** Whether a radio of `name` with `value` renders checked (attribute order independent). */
function checkedRadio(html: string, name: string, value: string): boolean {
  return [...html.matchAll(/<input\b[^>]*>/g)].some(match => match[0].includes(`name="${name}"`) && match[0].includes(`value="${value}"`) && /\schecked=""/.test(match[0]));
}

/** The HTML of the page section with this id, nested sections included. */
function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  if (start === -1) return "";
  const tag = /<section\b|<\/section>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0] === "</section>" ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return html.slice(start);
}

/** Visible text of the timing band titled `label` (Before entry, While live, After close) inside a section's HTML. */
function bandText(html: string, label: string): string {
  const start = html.search(new RegExp(`<h[34][^>]*>${label}<span`));
  if (start === -1) return "";
  const end = html.indexOf("</section>", start);
  return visibleText(html.slice(start, end === -1 ? undefined : end));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  m.timeDisplay = { mode: "strategy" };
  m.developerMode = false;
  m.preTradeProps = [];
  m.reviewProps = [];
  m.link = null;
  m.linkError = null;
  m.schemaReady = true;
  m.queries = [];
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------------------------
describe("trade workspace · drafts", () => {
  it("shows a blocked draft with its exact reasons, Edit draft as the one next action and no way to lock", async () => {
    const detail = blockedDraft();
    const html = await render(detail);
    const text = visibleText(html);
    expect(text).toContain("GBPUSD · Long");
    expect(text).toContain("Blocked");
    expect(text).toContain("Planned");
    expect(text).toContain("FTMO 100K");
    // §2.4: Edit draft with the first blocking reason inline.
    expect(html).toMatch(new RegExp(`<a class="[^"]*btn-primary[^"]*" href="/trades/${detail.tradeId}/edit"`));
    expect(text).toContain("Blocked: Requested risk 1.25% exceeds your configured maximum of 0.75%.");
    // §6.5: every blocking reason in its exact sentence, BLOCK before WARN, notes collapsed.
    expect(text).toContain("Requested risk 1.25% exceeds your configured maximum of 0.75%.");
    expect(text).toContain("Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00.");
    expect(text.indexOf("Dead Pool (12:00")).toBeLessThan(text.indexOf("Economic news has not been checked."));
    expect(text).toContain("1 note");
    expect(text).toContain("Risk check · 13:44 · revision 2");
    expect(text).toContain("Revision 2 · editing saves revision 3");
    expect(text).toContain("Check history · 2 checks");
    // Lock stays visible but inert, with the reason in words.
    expect(html).toMatch(/aria-disabled="true"[^>]*>[\s\S]{0,400}Lock plan/);
    expect(text).toContain("Locking opens once a check approves this revision.");
    expect(text).toContain("Recheck risk");
    // Values of the revision in words, never enum spellings.
    expect(text).toContain("OB first touch");
    expect(text).toContain("1.10000");
    expect(text).toContain("1.25%");
    expect(text).toContain("2.99R");
    expect(text).toContain("Economic news: Not checked");
    expect(text).toContain("Thesis Before entry");
    expect(text).toContain("Draft");
    // Pre-trade AI tools get the Risk Engine verdict and the current revision; nothing runs on load.
    expect(m.preTradeProps).toHaveLength(1);
    expect(m.preTradeProps[0]).toMatchObject({ tradeId: detail.tradeId, accountId: ACCOUNT, currentRevision: 2, riskDecision: "BLOCKED", riskLine: RISK_LIMIT.detail });
    expect(m.reviewProps).toHaveLength(0);
    // The tags of an open trade and the before-entry evidence stager with its page-level paste target.
    expect(text).toContain("Tags");
    expect(text).toContain("Add screenshots");
    expect(blocksOf(html)).toBe("main evidence journal");
    expectClean(html);
  });

  it("offers Lock plan for a current approval and passes the approved verdict to the AI tools", async () => {
    const detail = readyDraft();
    const html = await render(detail);
    const text = visibleText(html);
    expect(text).toContain("Ready to lock");
    expect(text).toContain("The free risk check approved revision 1 at 13:58. Lock the plan before you enter.");
    expect(text).toContain("Every hard rule passes for this revision.");
    expect(primaryButtonLabels(html)).toContain("Lock plan");
    expect(m.preTradeProps[0]).toMatchObject({ riskDecision: "APPROVED", riskLine: "" });
    // AI selection on the gallery (max 3 for pre-trade tools) only while AI can run.
    expect(text).toContain("Select up to 3 screenshots for AI");
    expect(html).toContain('aria-label="Use M5 chart');
    expectClean(html);
  });

  it("keeps the gallery without AI checkboxes when AI is not available", async () => {
    const html = await render(readyDraft(false));
    expect(visibleText(html)).not.toContain("Select up to");
    expect(html).not.toContain('type="checkbox" class="size-5');
  });

  it("states a draft's tags in words and keeps their editor collapsed", async () => {
    const detail = readyDraft();
    const tagged: TradeDetail = { ...detail, tags: { grade: "INVALID", liquidity: "PDH", mss: "M15", tags: ["london", "news week"], source: "V2" } };
    const html = await render(tagged);
    const text = visibleText(html);
    expect(text).toContain("Invalid setup · PDH · previous day high · MSS M15 · london, news week");
    expect(text).toContain("Edit tags");
    expect(html).toMatch(/<details class="disclosure"><summary[^>]*>[\s\S]*?Edit tags[\s\S]*?<\/summary>[\s\S]*?data-form="tags"/);
    expectClean(html);
  });

  it("asks for a recheck when an approval is no longer current, and says why", async () => {
    const html = await render(staleDraft());
    const text = visibleText(html);
    expect(text).toContain("Recheck needed");
    expect(text).toContain("Approved earlier");
    expect(text).toContain("This approval is no longer current");
    expect(text).toContain("The approval from 09:00 is no longer current. Recheck risk before locking.");
    expect(m.preTradeProps[0]).toMatchObject({ riskDecision: "RECHECK" });
    expectClean(html);
  });

  it("starts an unchecked draft with the free check and links the trade it was duplicated from", async () => {
    const detail = uncheckedDraft();
    const html = await render(detail);
    const text = visibleText(html);
    expect(text).toContain("Check risk (free)");
    expect(text).toContain("Not checked yet");
    expect(text).toContain("Run the free risk check first: locking needs an approval of this revision.");
    expect(text).toContain("Duplicated from an earlier trade.");
    expect(html).toContain(`href="/trades/${uuid(40)}"`);
    expect(m.preTradeProps[0]).toMatchObject({ riskDecision: "UNCHECKED" });
    expectClean(html);
  });

  it("leads a draft blocked on an earlier trading day with the free recheck, and dates the block", async () => {
    const detail = blockedYesterday();
    const html = await render(detail);
    const text = visibleText(html);
    expect(text).toContain("Blocked");
    // The stored sentence says "today" about the day of the check; the hint says which day that was.
    expect(text).toContain(
      "Blocked when checked Oct 22, 13:44: Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live). Today's limits and session can differ, so recheck risk before you edit the draft.",
    );
    expect(primaryButtonLabels(html)[0]).toBe("Recheck risk");
    expect(html).not.toMatch(new RegExp(`<a class="[^"]*btn-primary[^"]*" href="/trades/${detail.tradeId}/edit"`));
    expect(html).toMatch(new RegExp(`<a class="[^"]*btn-secondary[^"]*" href="/trades/${detail.tradeId}/edit"`));
    expect(text).toContain("Risk check · Oct 22, 13:44 · revision 1");
    expect(text).toContain("This check is from Oct 22; today's limits and session can differ, so recheck risk before you edit the draft.");
    expectClean(html);
  });

  it("offers the strategy card when the versions are known", async () => {
    const extras: TradeExtras = {
      ...EXTRAS,
      strategy: { context: "The strategy and the risk plan this draft is checked against today.", card: { title: "ICT V1.0", subtitle: "Risk Plan V1.1 · fixed UTC−5", sections: [], warnings: [] } },
    };
    const text = visibleText(await render(readyDraft(), extras));
    expect(text).toContain("Strategy card");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Locked, live and live-first
// ---------------------------------------------------------------------------------------------------------------------
describe("trade workspace · locked and live", () => {
  it("shows the sealed plan and the record-entry form prefilled from it", async () => {
    const detail = locked();
    const html = await render(detail);
    const text = visibleText(html);
    expect(text).toContain("Locked · waiting for entry");
    expect(text).toContain("Locked 02:52 · Risk Plan V1.1 · ICT V1.0 · immutable");
    expect(text).toContain("Locked plans can't be edited. Later changes are recorded in the journal.");
    expect(text).toContain("Risk Engine at lock");
    expect(text).toContain("2 warnings and notes at lock");
    // §2.4: Record entry is the next action and jumps to the form; Skip is in the menu and beside the form.
    expect(html).toMatch(/<a href="#record-entry"[^>]*class="[^"]*btn-primary/);
    expect(html).toContain('id="record-entry"');
    expect(html).toContain('value="1.10000"');
    expect(html).toContain('value="0.88"');
    expect(text).toContain("Plan 1.10000");
    expect(text).toContain("Plan 0.88 lots");
    expect(text).toContain("Entry time");
    expect(text).toContain("Now");
    expect(text).toContain("Earlier");
    expect(text).toContain("Skip this trade…");
    expect(text).toContain("Recorded once: the fill can't be changed later.");
    expect(m.preTradeProps).toHaveLength(0);
    expectClean(html);
  });

  it("leads with the journal while a planned position is live, with plan vs reality and the close form", async () => {
    const html = await render(plannedLive());
    const text = visibleText(html);
    expect(text).toContain("Live");
    expect(text).toContain("Entered 03:05 · live 10h 55m");
    expect(html).toMatch(/<a href="#journal"[^>]*class="[^"]*btn-primary/);
    expect(text).toContain("Add to journal");
    expect(text).toContain("Close trade");
    expect(blocksOf(html)).toBe("journal main evidence");
    // The composer docks above the tab bar on phones and takes page-level paste.
    expect(html).toContain("max-md:sticky");
    expect(text).toContain("Add to trade journal…");
    // Timeline bands with exact labels, and the flag of a note written after the reported entry (§5.3).
    expect(text).toContain("Before entry");
    expect(text).toContain("While live");
    expect(text).toContain("Recorded after execution began");
    expect(text).toContain("Stop moved to 1.10000");
    // §8.5 plan vs reality: slippage, size ratio with the Oversized flag, risk at the stop.
    expect(text).toContain("Plan vs reality");
    expect(text).toContain("+2 ticks · +0.2 pips (worse than plan)");
    expect(text).toContain("2.00× of plan");
    expect(text).toContain("Oversized");
    expect(text).toContain("After close");
    // Each measure is a row header, so the planned and actual cells are announced with it.
    expect(html).toMatch(/<th scope="row"[^>]*>Entry<\/th>/);
    expect(html).toMatch(/<th scope="row"[^>]*>Planned RR → realized R<\/th>/);
    // An open trade keeps its tags behind "Add tags" / "Edit tags", with what is set in words.
    expect(text).toContain("No tags yet.");
    expect(text).toContain("Add tags");
    expect(text).not.toContain("Mark reviewed");
    // Close form (§3.6): one exit for the whole position, R based on the locked risk.
    expect(text).toContain("Average exit price (all partials)");
    expect(text).toContain("One price for the whole position. Partial closes stay in the journal.");
    expect(text).toContain("R based on locked risk: realized R = net P&L ÷ $500.00.");
    expect(html).toContain('id="close-trade"');
    expectClean(html);
  });

  it("shows a live-first position with the exact no-plan banner, its facts and the missing details", async () => {
    const html = await render(liveFirst(), { ...EXTRAS, instruments: [{ id: uuid(950), label: "DE40 · tick 0.1 · contracts" }] });
    const text = visibleText(html);
    expect(text).toContain("No pre-trade plan was recorded before execution.");
    expect(html).toContain('title="No pre-trade plan was recorded before execution."');
    expect(text).toContain("Live-first");
    expect(text).not.toContain("Plan Locked");
    expect(html).not.toContain('id="plan"');
    expect(text).toContain("No pre-trade plan recorded");
    expect(text).toContain("Not recorded");
    // "Add entry details": only what is missing, each once.
    expect(text).toContain("Add entry details");
    expect(text).toContain("Each missing detail can be added once. Recorded details can't be changed later.");
    expect(text).toContain("DE40 · tick 0.1 · contracts");
    expect(text).toContain("Initial stop");
    expect(text).toContain("Risk amount");
    expect(text).not.toMatch(/Entry price\s*\*?\s*Entry time/);
    // Without a contract and size, the close needs the reported net P&L with an explicit sign.
    expect(text).toContain("P&L can't be calculated because the instrument contract and the size are not recorded.");
    expect(text).toContain("Profit");
    expect(text).toContain("Breakeven");
    expect(text).toContain("No risk is recorded for this trade, so realized R won't be available.");
    expect(m.preTradeProps).toHaveLength(0);
    expectClean(html);
  });

  it("says which live-first entry details were added after the position was recorded, and when", async () => {
    const extras: TradeExtras = {
      ...EXTRAS,
      positionRecords: [
        { recordedAt: "2026-10-23T18:10:00Z", details: ["entryPrice", "enteredAt"] },
        { recordedAt: "2026-10-23T18:20:00Z", details: ["initialStop", "riskAmount"] },
      ],
    };
    const html = await render(liveFirst({ initial_stop: "23500.1", initial_risk: "51.8" }), extras);
    const text = visibleText(sectionOf(html, "execution"));
    expect(text).toContain("Stop 23500.1 Added 13:20");
    expect(text).toContain("Risk at stop €51.80 Risk amount you recorded · added 13:20");
    expect(text).toContain("Entry 23476.1 Entry time 13:05 Size");
    expect(text).toContain("Recorded 13:10, with the position already open. Details marked “Added” were completed later.");
    expectClean(html);
  });

  it("reads the decision history in causal order when a save or a lock is milliseconds apart", async () => {
    const proposalId = uuid(1501);
    const detail = detailOf({
      trade: ledger(15, { ...LOCKED_FIELDS, lifecycle: "LOCKED", created_at: "2026-10-23T07:40:00.000000Z", locked_at: "2026-10-23T07:52:00.608822Z" }),
      revisions: [{ proposalId, revision: 1, createdAt: "2026-10-23T07:40:00.009777Z" }],
      timelineChecks: [
        { id: uuid(1502), recordedAt: "2026-10-23T07:40:00.000000Z", decision: "APPROVED", proposalId },
        { id: uuid(1503), recordedAt: "2026-10-23T07:52:00.625822Z", decision: "APPROVED", proposalId },
      ],
      checks: [check("APPROVED", "2026-10-23T07:40:00.000000Z", 1), check("APPROVED", "2026-10-23T07:52:00.625822Z", 1)],
    });
    const before = bandText(sectionOf(await render(detail), "journal"), "Before entry");
    const positions = ["Draft created", "Risk check: Approved", "Plan locked"].map(title => before.indexOf(title));
    expect(positions.every(position => position >= 0)).toBe(true);
    // Draft created → its check → the lock's check → Plan locked.
    expect(before.indexOf("Draft created")).toBeLessThan(before.indexOf("Risk check: Approved"));
    expect(before.lastIndexOf("Risk check: Approved")).toBeLessThan(before.indexOf("Plan locked"));
    expect(before.indexOf("Risk check: Approved")).not.toBe(before.lastIndexOf("Risk check: Approved"));
  });

  it("explains how to add a contract when the account has none for the symbol", async () => {
    const text = visibleText(await render(liveFirst()));
    expect(text).toContain("This account has no DE40 contract, so P&L can't be calculated from prices.");
    expect(text).toContain("Add the instrument");
  });

  it("calculates the close of a live-first position whose contract, entry and size are known", async () => {
    const html = await render(detailOf({
      trade: ledger(12, {
        origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_proposal_id: null, lifecycle: "LIVE", draft_check: null, planned_entry: null, planned_stop: null,
        planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null, entered_at: "2026-10-23T18:05:00Z",
        entry_price: "1.16074", quantity: "2.5", initial_stop: "1.16224", initial_risk: "375", entry_model: "OTHER",
      }),
    }));
    const text = visibleText(html);
    expect(html).toContain('data-mode="calculated"');
    expect(text).not.toContain("P&L can't be calculated");
    expect(text).toContain("R based on risk recorded after entry: realized R = net P&L ÷ $375.00.");
    expect(text).not.toContain("Add entry details");
    expect(text).toContain("Other model");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Closed, reviewed and ended without a trade
// ---------------------------------------------------------------------------------------------------------------------
describe("trade workspace · result and review", () => {
  it("shows the realized result with its calculation basis and the review with lessons and Mark reviewed", async () => {
    const detail = closedPlanned();
    const html = await render(detail);
    const text = visibleText(html);
    expect(text).toContain("Closed · review pending");
    expect(text).toContain(`${formatR("3.06")} +$1,530.00 Win`);
    expect(text).toContain("R based on locked risk · realized R = net P&L ÷ $500.00");
    // The outcome in words leads the Result section; realized R and net P&L are its two figures.
    expect(text).toContain("Result Win · closed 05:50 Realized R +3.06R Net P&L +$1,530.00");
    expect(text).toContain("Average exit price");
    expect(text).toContain("1.10612");
    expect(text).toContain("Recorded 13:44");
    expect(text).toContain("Held");
    expect(text).toContain("2h 45m");
    // §2.4: Write review is the next action; the review itself completes with Mark reviewed.
    expect(html).toMatch(/<a href="#review"[^>]*class="[^"]*btn-primary/);
    expect(text).toContain("Review pending");
    expect(text).toContain("Mark reviewed");
    expect(text).toContain("Textbook London session: no interference.");
    expect(text).toContain("After close · 13:45");
    expect(text).toContain("Add a lesson");
    // Tags in words.
    expect(text).toContain("Setup grade");
    expect(text).toContain("Asian range low");
    expect(checkedRadio(html, "grade", "A+")).toBe(true);
    expect(checkedRadio(html, "mss", "M5")).toBe(true);
    // One next action: besides the journal composer's own submit, the header's Write review is the only primary control.
    expect(primaryButtonLabels(html)).toEqual(["Write review", "Add to journal"]);
    expect(text).toContain("london");
    // The AI review gets the closed state; selection max 4 for a review.
    expect(m.reviewProps).toHaveLength(1);
    expect(m.reviewProps[0]).toMatchObject({ tradeId: detail.tradeId, accountId: ACCOUNT, closed: true, noPlan: false });
    expect(text).toContain("Select up to 4 screenshots for AI");
    expect(blocksOf(html)).toBe("main journal evidence");
    expect(text).toContain("After close");
    expectClean(html);
  });

  it("says when realized R is not available and offers Reopen review on a reviewed trade", async () => {
    const html = await render(reviewedLiveFirstWithoutRisk());
    const text = visibleText(html);
    expect(text).toContain("Reviewed");
    expect(text).toContain("+$102.47 Win · realized R not available");
    expect(text).toContain("Not available");
    expect(text).toContain("No risk was recorded, so realized R is not available.");
    expect(text).toContain("Reviewed Sep 23, 22:59. Tags and lessons stay editable; reopen the review to mark it pending again.");
    expect(text).toContain("Reopen review");
    expect(text).not.toContain("Mark reviewed");
    expect(text).toContain("No pre-trade plan was recorded before execution.");
    expect(m.reviewProps[0]).toMatchObject({ closed: true, noPlan: true });
    expectClean(html);
  });

  it("explains a skipped plan with its reason and keeps tags and lessons", async () => {
    const html = await render(skipped());
    const text = visibleText(html);
    expect(text).toContain("Skipped");
    expect(text).toContain("Skipped before entry · 04:55");
    expect(text).toContain("“Price never returned to the order block.”");
    expect(text).toContain("Tags & lessons");
    expect(text).not.toContain("Record entry");
    expect(html).not.toContain('id="execution"');
    expect(html).not.toContain('id="result"');
    expectClean(html);
  });

  it("keeps what was recorded after a skip out of Before entry, in the timeline, the gallery and the lessons", async () => {
    const html = await render(skippedWithHindsight());
    const journal = sectionOf(html, "journal");
    expect(visibleText(journal)).toContain("new entries: after the skip");
    const beforeEntry = bandText(journal, "Before entry");
    expect(beforeEntry).toContain("H4 chart added");
    expect(beforeEntry).toContain("Trade skipped");
    expect(beforeEntry).not.toContain("M15 chart added");
    expect(beforeEntry).not.toContain("the skip cost a winner");
    const afterward = bandText(journal, "After close");
    expect(afterward).toContain("M15 chart added");
    expect(afterward).toContain("the skip cost a winner");
    const evidence = sectionOf(html, "evidence");
    expect(bandText(evidence, "Before entry")).toContain("H4 FVG still open above");
    expect(bandText(evidence, "Before entry")).not.toContain("Where price went after the skip");
    expect(bandText(evidence, "After close")).toContain("Where price went after the skip");
    expect(visibleText(sectionOf(html, "review"))).toContain("After the skip · 05:16");
    expectClean(html);
  });

  it("keeps a discarded draft's last revision and reason readable, with no review", async () => {
    const extras: TradeExtras = { ...EXTRAS, lastProposal: proposal({ narrative: "Daily bias was bearish." }) };
    const html = await render(discarded(), extras);
    const text = visibleText(html);
    expect(text).toContain("Discarded");
    expect(text).toContain("Draft discarded · 13:44");
    expect(text).toContain("“Setup is three days old.”");
    expect(text).toContain("Draft revision 1 · never locked");
    expect(text).toContain("Daily bias was bearish.");
    expect(text).toContain("Last risk check");
    expect(text).not.toContain("at lock");
    expect(html).not.toContain('id="review"');
    expectClean(html);
  });

  it("falls back to the ledger values when a discarded draft's revision can't be read", async () => {
    const text = visibleText(await render(discarded()));
    expect(text).toContain("The thesis couldn't be loaded right now.");
    expect(text).toContain("1.10000");
    expect(text).not.toContain("Economic news:");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Time display, technical details, metadata, not found
// ---------------------------------------------------------------------------------------------------------------------
describe("trade workspace · page", () => {
  it("formats times in the person's time display", async () => {
    m.timeDisplay = { mode: "utc" };
    const text = visibleText(await render(locked()));
    expect(text).toContain("Locked 07:52 · Risk Plan V1.1 · ICT V1.0 · immutable");
  });

  it("keeps ids, versions and raw reports inside Technical details, opened by developer mode", async () => {
    const detail = closedPlanned();
    const closedHtml = await render(detail);
    expect(closedHtml).toContain('id="technical-details"');
    expect(closedHtml).toMatch(/<details[^>]*class="[^"]*technical-details[^"]*"[^>]*>[\s\S]*FULL_CLOSE_V1|<details[^>]*class="[^"]*technical-details[^"]*"[^>]*>[\s\S]*CALCULATED/);
    expect(closedHtml).toContain(detail.tradeId);
    expect(closedHtml).not.toMatch(/<details[^>]*open=""[^>]*class="[^"]*technical-details/);
    m.developerMode = true;
    const developerHtml = await render(detail);
    expect(developerHtml).toMatch(/<details[^>]*open=""[^>]*class="[^"]*technical-details|<details[^>]*class="[^"]*technical-details[^"]*"[^>]*open=""/);
  });

  it("titles the page with the trade and 404s a trade that isn't the user's", async () => {
    m.detail = closedPlanned();
    await expect(generateMetadata({ params: Promise.resolve({ id: uuid(8) }) })).resolves.toEqual({ title: "EURUSD · Long · Trade · Trading OS" });
    m.detail = null;
    await expect(TradePage({ params: Promise.resolve({ id: uuid(99) }) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    await expect(generateMetadata({ params: Promise.resolve({ id: uuid(99) }) })).resolves.toEqual({ title: "Trade · Trading OS" });
  });

  it("renders a not-found state that never reveals which trades exist", () => {
    const html = renderToStaticMarkup(createElement(TradeNotFound));
    expect(visibleText(html)).toContain("This trade isn't available.");
    expect(html).toContain('href="/journal"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it("loads with skeletons shaped like the workspace", () => {
    const html = renderToStaticMarkup(createElement(TradeLoading));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading trade");
    expect(html).toContain("skeleton");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Legacy /journal/<plan id> (spec §1.2)
// ---------------------------------------------------------------------------------------------------------------------
describe("legacy plan page", () => {
  const PLAN = "b0000000-0000-4000-8000-000000000001";
  const TRADE = "c0000000-0000-4000-8000-000000000001";

  it("redirects a plan the user owns to its trade through trade_plan_links", async () => {
    m.link = { trade_id: TRADE };
    await expect(LegacyPlanPage({ params: Promise.resolve({ id: PLAN.toUpperCase() }) })).rejects.toMatchObject({ digest: expect.stringContaining(`/trades/${TRADE}`) });
    expect(m.queries).toEqual(["trade_plan_links", `plan_id=${PLAN}`, `user_id=${USER}`]);
  });

  it("is not found for an unknown or foreign plan and for a malformed id", async () => {
    m.link = null;
    await expect(LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    await expect(LegacyPlanPage({ params: Promise.resolve({ id: "not-a-plan" }) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(m.queries.filter(query => query === "trade_plan_links")).toHaveLength(1);
  });

  it("answers an unknown, foreign or malformed plan link with a designed card and the ways back", async () => {
    const html = renderToStaticMarkup(await LegacyPlanNotFound());
    const text = visibleText(html);
    expect(text).toContain("This plan link isn't available");
    expect(text).toContain("The plan may not exist, or it belongs to someone else. Nothing was changed.");
    expect(html).toContain('href="/today"');
    expect(html).toContain('href="/journal"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(text).not.toMatch(UUID);
  });

  it("fails loudly on a read error and sends an outdated database to the app's update notice", async () => {
    m.linkError = { message: "boom" };
    await expect(LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) })).rejects.toThrow("Trade unavailable");
    m.schemaReady = false;
    await expect(LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) })).rejects.toMatchObject({ digest: expect.stringContaining("/today") });
  });
});
