import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/trades", () => ({ relabelEvidence: vi.fn(), removeEvidence: vi.fn() }));
vi.mock("@/app/actions/journal", () => ({ addJournalEntry: vi.fn() }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined }),
}));

import { EvidenceJournalDemo } from "@/components/evidence/dev-demo";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const visibleText = (markup: string) => {
  const outside = markup.replace(/<details class="disclosure technical-details"[\s\S]*?<\/details>/g, " ");
  return [outside.replace(/<[^>]+>/g, " "), ...[...outside.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1])].join(" ");
};

describe("developer gallery specimen", () => {
  it("renders the synthetic live trade's composer, timeline and gallery offline, without raw ids", () => {
    const markup = renderToStaticMarkup(createElement(EvidenceJournalDemo)).replaceAll("<!-- -->", "");
    expect(markup).toContain("Live journal · EURUSD long (synthetic)");
    expect(markup).toContain('placeholder="Add to trade journal…"');
    expect(markup).toContain('id="demo-journal-composer"');
    expect(markup).toContain("Stop moved to 1.08480");
    expect(markup).toContain(">07:42<span> · recorded 08:05</span>");
    expect(markup).toContain("Select up to 3 screenshots for AI");
    expect(markup).toContain("AI panels read the same selection: 0 of 3 screenshots chosen.");
    expect(markup).toContain('src="data:image/svg+xml;charset=utf-8,');
    expect(markup).toContain("Plan Trade: screenshots are saved with the draft");
    expect(visibleText(markup)).not.toMatch(UUID);
  });
});
