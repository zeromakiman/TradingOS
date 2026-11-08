import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the trade page mounts pre-trade AI (docs/V2_ARCHITECTURE.md §8.3, §11.1, §14.4): the real TradeWorkspace and
// its real layout (`workspaceLayout`), with every section stubbed so the test sees only what the workspace decides:
// whether PreTradeAiPanel is mounted, with which frame and props, and where. The panel itself is tested in
// v2-ui-ai-panels; the sections in v2-screen-trade.

const m = vi.hoisted(() => ({ preTrade: [] as Record<string, unknown>[], planAi: [] as boolean[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/components/ai/pre-trade-ai-panel", () => ({
  PreTradeAiPanel: (props: Record<string, unknown>) => {
    m.preTrade.push(props);
    return createElement("div", { "data-stub": "pre-trade-ai", "data-frame": String(props.frame) });
  },
}));
vi.mock("@/components/ai/trade-review-ai-panel", () => ({ TradeReviewAiPanel: () => createElement("div", { "data-stub": "trade-review-ai" }) }));
vi.mock("@/components/trade/plan-section", () => ({
  PlanSection: ({ ai }: { ai: ReactNode }) => {
    m.planAi.push(ai !== null && ai !== undefined);
    return createElement("section", { id: "plan" }, ai);
  },
}));
vi.mock("@/components/trade/execution-section", () => ({ ExecutionSection: () => createElement("section", { id: "execution" }) }));
vi.mock("@/components/trade/result-section", () => ({ ResultSection: () => createElement("section", { id: "result" }) }));
vi.mock("@/components/trade/review-section", () => ({ ReviewSection: ({ ai }: { ai: ReactNode }) => createElement("section", { id: "review" }, ai) }));
vi.mock("@/components/trade/journal-section", () => ({ JournalSection: () => createElement("section", { id: "journal" }) }));
vi.mock("@/components/trade/evidence-section", () => ({ EvidenceSection: () => createElement("section", { id: "evidence" }) }));
vi.mock("@/components/trade/technical-section", () => ({ TechnicalSection: () => createElement("section", { id: "technical" }) }));
vi.mock("@/components/trade/trade-header", () => ({ TradeHeader: () => createElement("header", null, "Header") }));
vi.mock("@/components/trade/trade-progress", () => ({ TradeProgress: () => null }));
vi.mock("@/components/trade/journal-focus", () => ({ TradeHashFocus: () => null }));
// Page facts the workspace only passes through; the layout (`workspaceLayout`) stays real.
vi.mock("@/components/trade/model", async importOriginal => ({
  ...(await importOriginal<typeof import("@/components/trade/model")>()),
  lockSummary: () => null,
  evidenceMode: () => ({ selectable: false, max: 0 }),
  duplicateNotes: () => [],
  aiRiskDecision: () => "APPROVED",
  aiRiskLine: () => "",
}));

import { TradeWorkspace } from "@/components/trade/trade-workspace";
import type { TradeDetail } from "@/lib/trades-data";

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const KEYS = { composer: "k1", duplicate: "k2", discard: "k3", reopen: "k4", review: "k5", entryDetails: "k6" };

interface Scenario {
  lifecycle: string;
  origin?: string;
  archived?: boolean;
  /** Pre-trade requests per draft revision in the trade's AI history (any status); null: the history could not be read. */
  requests?: number[] | null;
  /** Completed pre-trade analyses of the activity read model. */
  completed?: number;
}

/** Only what TradeWorkspace reads itself; every section that reads more is stubbed. */
function detailOf({ lifecycle, origin = "PLANNED", archived = false, requests = [], completed = 0 }: Scenario): TradeDetail {
  const groups = (requests ?? []).map((count, index) => ({ number: index + 1, current: false, label: `Revision ${index + 1}`, rows: Array.from({ length: count }, () => ({})) }));
  return {
    tradeId: TRADE,
    account: { id: ACCOUNT, name: "FTMO 100K", currency: "USD", status: archived ? "ARCHIVED" : "ACTIVE" },
    origin,
    state: { lifecycle },
    revisionCount: 2,
    draft: lifecycle === "DRAFT" ? { revision: 2 } : null,
    evidence: { items: [] },
    ai: {
      activity: { reviews: 0, preTradeAnalyses: completed, lastCompletedAt: null },
      history: requests === null ? null : { latestRevision: 2, preTrade: groups, reviews: [], error: null },
      available: true,
    },
  } as unknown as TradeDetail;
}

function render(scenario: Scenario): string {
  return renderToStaticMarkup(
    createElement(TradeWorkspace, { detail: detailOf(scenario), extras: {} as never, now: "2026-10-23T19:00:00.000Z", display: { mode: "strategy" }, developerMode: false, keys: KEYS }),
  );
}

/** Where each section and the pre-trade AI stub sit in the page, in document order. */
function order(html: string): string[] {
  return [...html.matchAll(/<section id="([a-z-]+)"|data-stub="pre-trade-ai"/g)].map(match => match[1] ?? "pre-trade-ai");
}

/** The HTML of the Plan section (its stub has no nested sections). */
const planHtml = (html: string) => /<section id="plan">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

beforeEach(() => {
  m.preTrade = [];
  m.planAi = [];
});

describe("pre-trade AI on the trade page", () => {
  it("offers the tools inside the Plan of an open draft of an active account, analyses or not", () => {
    const html = render({ lifecycle: "DRAFT" });
    expect(m.preTrade).toHaveLength(1);
    expect(m.preTrade[0]).toMatchObject({ tradeId: TRADE, accountId: ACCOUNT, accountArchived: false, currentRevision: 2, frame: "plan" });
    expect(planHtml(html)).toContain('data-stub="pre-trade-ai"');
    expect(m.planAi).toEqual([true]);
  });

  it("keeps a locked or live trade's analyses readable in a section of their own, after the Plan and before Execution", () => {
    for (const lifecycle of ["LOCKED", "LIVE"]) {
      m.preTrade = [];
      const html = render({ lifecycle, requests: [1, 2] });
      expect(m.preTrade).toHaveLength(1);
      // No open draft: the revision passed is the trade's latest, and the panel itself offers no tool.
      expect(m.preTrade[0]).toMatchObject({ tradeId: TRADE, accountId: ACCOUNT, accountArchived: false, currentRevision: 2, frame: "section" });
      expect(planHtml(html)).not.toContain("pre-trade-ai");
      const sections = order(html);
      expect(sections.indexOf("pre-trade-ai")).toBe(sections.indexOf("plan") + 1);
      expect(sections.indexOf("execution")).toBe(sections.indexOf("pre-trade-ai") + 1);
    }
  });

  it("does the same once the trade is closed, reviewed, skipped, cancelled or discarded, and on an archived account", () => {
    for (const lifecycle of ["CLOSED", "REVIEWED", "SKIPPED", "CANCELLED", "DISCARDED"]) {
      for (const archived of [false, true]) {
        m.preTrade = [];
        const html = render({ lifecycle, archived, requests: [1] });
        expect(m.preTrade).toHaveLength(1);
        expect(m.preTrade[0]).toMatchObject({ frame: "section", accountArchived: archived });
        const sections = order(html);
        expect(sections.indexOf("pre-trade-ai")).toBe(sections.indexOf("plan") + 1);
      }
    }
  });

  it("falls back to the completed analyses of the activity read model when the AI history could not be read", () => {
    render({ lifecycle: "LOCKED", requests: null, completed: 1 });
    expect(m.preTrade).toEqual([expect.objectContaining({ frame: "section" })]);
  });

  it("keeps an archived account's draft analyses in its Plan, without tools, and shows nothing when there are none", () => {
    const html = render({ lifecycle: "DRAFT", archived: true, requests: [2] });
    expect(m.preTrade).toEqual([expect.objectContaining({ frame: "plan", accountArchived: true })]);
    expect(planHtml(html)).toContain('data-stub="pre-trade-ai"');
    m.preTrade = [];
    render({ lifecycle: "DRAFT", archived: true });
    expect(m.preTrade).toEqual([]);
  });

  it("mounts nothing for a trade without pre-trade analyses once it is no longer a draft: no empty section, no placeholder", () => {
    for (const lifecycle of ["LOCKED", "LIVE", "CLOSED", "REVIEWED", "SKIPPED", "CANCELLED", "DISCARDED"]) {
      const html = render({ lifecycle });
      expect(html).not.toContain("pre-trade-ai");
      expect(html).not.toContain("Loading pre-trade AI");
    }
    expect(m.preTrade).toEqual([]);
  });

  it("never mounts pre-trade AI on live-first or imported trades", () => {
    for (const origin of ["LIVE_FIRST", "IMPORTED"]) {
      for (const lifecycle of ["LIVE", "CLOSED", "REVIEWED"]) render({ lifecycle, origin, requests: [3], completed: 3 });
    }
    expect(m.preTrade).toEqual([]);
  });
});
