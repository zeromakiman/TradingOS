import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSourceChip } from "@/domain/ai-summary";
import { revealTradeTarget, tradeTargetOf } from "@/components/trade/reveal";

// next/link renders the same <a> on the server; marking it tells a client-side link from a plain anchor.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { ...rest, href, "data-client-link": "" }, children),
}));

import { SourceChip } from "@/components/ai/source-chip";

// A weekly, recent-trades or monthly review lists many trades and has no timeline of its own: its note and event chips
// open the trade's timeline item, /trades/<trade>#journal:<id> (docs/V2_ARCHITECTURE.md §11.1). The trade page streams
// in after its loading skeleton, so neither the browser nor Next.js finds that fragment on a client navigation: the
// page's hash focus (TradeHashFocus: tradeTargetOf + revealTradeTarget) brings the item into view once it is there.

const TRADE = "90000000-0000-4000-8000-000000000001";
const JOURNAL = "70000000-0000-4000-8000-000000000002";
const EVENT = "60000000-0000-4000-8000-000000000004";

const facts = {
  version: "RECENT_TRADES_FACTS_V2",
  trades: [{
    tradeId: "30000000-0000-4000-8000-000000000001", tradeRecordId: TRADE, originalPlan: { instrument: "EURUSD", proposal: { direction: "LONG" } },
    execution: { exited_at: "2026-09-07T12:00:00Z" }, journal: [[JOURNAL, "NOTE", "2026-09-07T10:11:00Z", "WHILE_LIVE", "Holding."]],
    events: [{ id: EVENT, event_type: "STOP_MOVED", occurred_at: "2026-09-07T10:30:00Z", recorded_at: "2026-09-07T10:30:00Z" }],
  }],
};

/** A timeline `<li id>` with the DOM methods the reveal uses. */
function timelineItem(id: string) {
  const attributes = new Map<string, string>();
  return {
    id,
    scrollIntoView: vi.fn(),
    focus: vi.fn(),
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
}

function stubPage(...items: ReturnType<typeof timelineItem>[]) {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("document", { getElementById: (id: string) => items.find(item => item.id === id) ?? null, querySelector: () => null });
}

afterEach(() => vi.unstubAllGlobals());

describe("periodic source chips open the trade's timeline item", () => {
  it("the hash a periodic note or event chip opens is a target of the trade page", () => {
    for (const [source, anchor] of [[`journal:${JOURNAL}`, `journal:${JOURNAL}`], [`event:${EVENT}`, `event:${EVENT}`]] as const) {
      const href = resolveSourceChip(source, facts).href ?? "";
      const url = new URL(href, "http://localhost");
      expect(url.pathname).toBe(`/trades/${TRADE}`);
      expect(tradeTargetOf(url.hash)).toBe(anchor);
    }
  });

  it("names a journal entry or event of the timeline by its UUID, and keeps every other hash as it was", () => {
    expect(tradeTargetOf(`#journal:${JOURNAL}`)).toBe(`journal:${JOURNAL}`);
    expect(tradeTargetOf(`event:${EVENT}`)).toBe(`event:${EVENT}`);
    expect(tradeTargetOf("#journal")).toBe("journal");
    expect(tradeTargetOf("#close-trade")).toBe("close-trade");
    for (const other of [`#journal:${JOURNAL}x`, "#journal:../x", "#journal:", `#trade:${JOURNAL}`, `#evidence-${JOURNAL}`, `#entry:${JOURNAL}`, "#journal-composer", ""]) {
      expect(tradeTargetOf(other), other).toBeNull();
    }
  });

  it("scrolls the item into view and focuses the item itself, without motion when reduced motion is asked for", () => {
    const item = timelineItem(`journal:${JOURNAL}`);
    stubPage(item);
    expect(revealTradeTarget(`journal:${JOURNAL}`)).toBe(true);
    expect(item.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    // A list item takes focus only with a tabindex: -1 keeps it out of the tab order.
    expect(item.getAttribute("tabindex")).toBe("-1");
    expect(item.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves the page alone when the timeline does not show the record", () => {
    const other = timelineItem(`event:${EVENT}`);
    stubPage(other);
    expect(revealTradeTarget(`journal:${JOURNAL}`)).toBe(false);
    expect(other.scrollIntoView).not.toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
  });

  it("a V1 chip that goes through /journal/<plan>#… is a plain link, so the redirect keeps the fragment (K23)", () => {
    const PLAN = "50000000-0000-4000-8000-000000000001";
    const html = (href: string) => renderToStaticMarkup(createElement(SourceChip, { chip: { label: "Stop moved · 10:30", kind: "event", href } }));
    const v1 = html(`/journal/${PLAN}#event:${EVENT}`);
    expect(v1).toContain(`href="/journal/${PLAN}#event:${EVENT}"`);
    expect(v1).not.toContain("data-client-link");
    // The V2 chip opens the trade itself, where TradeHashFocus reveals the item after a client-side navigation.
    expect(html(`/trades/${TRADE}#event:${EVENT}`)).toContain("data-client-link");
    // A V1 trade chip without a fragment keeps the client-side link.
    expect(html(`/journal/${PLAN}`)).toContain("data-client-link");
  });
});
