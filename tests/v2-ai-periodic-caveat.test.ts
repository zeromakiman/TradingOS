import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { facts as monthlyFacts, monthlyOutput } from "./fixtures/monthly-review";
import { weeklyOutput, facts as weeklyFacts } from "./fixtures/weekly-review";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn() }));

import { FullAnalysisBody } from "@/components/ai/full-analysis-sheet";
import { sectionModels } from "@/components/ai/model";
import { CHANGE_EVIDENCE_NOTE } from "@/domain/ai-summary";
import { type AiHistoryRow, resolvedCard } from "@/lib/ai-history";

// The monthly comparison caveat kept from V1 (tests/ai-failure-accounting-ui.test.ts at bc5441c, "monthly comparison
// notice preserves historical interpretation…"), along the path a stored result takes to "View full analysis":
// stored output and facts → resolvedCard → sectionModels → FullAnalysisBody (src/components/ai/operation-cards.tsx).

const completed = (contract: string) => ({ status: "COMPLETED", technical: { contract } }) as unknown as AiHistoryRow;
const notesOf = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3><p role="note"[^>]*>([^<]+)<\/p>/g)].map(match => [match[1], match[2]]);

describe("monthly comparison caveat in the full analysis", () => {
  it("a stored monthly review shows the caveat from Trading OS under What improved and What degraded, apart from the AI text", () => {
    const card = resolvedCard(completed("MONTHLY_REVIEW_V1"), monthlyOutput, monthlyFacts);
    if (!card) throw new Error("Expected a monthly card");
    expect(card.full.filter(section => section.note).map(section => section.id)).toEqual(["whatImproved", "whatDegraded"]);
    const html = renderToStaticMarkup(createElement(FullAnalysisBody, { sections: sectionModels(card.full) }));
    expect(notesOf(html)).toEqual([["What improved", CHANGE_EVIDENCE_NOTE], ["What degraded", CHANGE_EVIDENCE_NOTE]]);
    expect(html).toContain("Change requires comparable earlier and later evidence.");
    expect(html).toContain("Record completeness alone does not establish improvement or degradation.");
    // The concise card's sections carry no caveat.
    expect(sectionModels(card.sections).some(section => "note" in section)).toBe(false);
  });

  it("other reviews show no caveat", () => {
    const card = resolvedCard(completed("WEEKLY_REVIEW_V1"), weeklyOutput, weeklyFacts);
    if (!card) throw new Error("Expected a weekly card");
    expect(renderToStaticMarkup(createElement(FullAnalysisBody, { sections: sectionModels(card.full) }))).not.toContain('role="note"');
  });
});
