import { type ComponentType, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/trades", () => ({ relabelEvidence: vi.fn(), removeEvidence: vi.fn() }));

import { EvidenceGallery } from "@/components/evidence/gallery";
import {
  EVIDENCE_HASH_PREFIX, evidenceHref, evidenceIdFromHash, evidenceTileId, type EvidenceViewSource, type GalleryItem, galleryBands, galleryItemName, toGalleryItem,
  toGalleryItems,
} from "@/components/evidence/gallery-model";
import { EvidenceSelectionProvider, toggleSelection, useEvidenceSelection } from "@/components/evidence/selection";
import { copiedNoteText, EVIDENCE_ACTIONS, EvidenceDetails, EvidenceRelabelForm, EvidenceViewer, recordedTimeText } from "@/components/evidence/viewer";
import { TimeDisplayProvider } from "@/components/shell/time-display";
import { STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RAW_CODES = /\b(BEFORE_ENTRY|WHILE_LIVE|AFTER_CLOSE|PRE_ENTRY|MANAGEMENT|LEGACY|V2|RECORDED_AFTER_EXECUTION_BEGAN|DAILY|HTF_)\b/;
const TRADE = "7d3c2f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const ID = {
  m5: "00000000-0000-4000-8000-0000000000f1",
  h4: "00000000-0000-4000-8000-0000000000f2",
  live: "00000000-0000-4000-8000-0000000000f3",
  exit: "00000000-0000-4000-8000-0000000000f4",
  removed: "00000000-0000-4000-8000-0000000000f5",
};

/** Visible text: content plus the attributes assistive technology reads; Technical details are excluded. */
const visibleText = (markup: string) => {
  const outside = markup.replace(/<details class="disclosure technical-details"[\s\S]*?<\/details>/g, " ");
  return [outside.replace(/<[^>]+>/g, " "), ...[...outside.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1])].join(" ");
};

function galleryItem(id: string, overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id, kind: "V2", label: "PRE_ENTRY", timeframe: null, caption: null, timing: "BEFORE_ENTRY", recordedAt: "2026-09-04T12:35:00Z",
    thumbUrl: `/api/evidence/${id}?variant=thumb`, fullUrl: `/api/evidence/${id}`, width: 1600, height: 900, ...overrides,
  };
}

const ITEMS: GalleryItem[] = [
  galleryItem(ID.exit, { label: "EXIT", timing: "AFTER_CLOSE", recordedAt: "2026-09-04T15:06:00Z", caption: "Closed into the PDH" }),
  galleryItem(ID.live, { label: "MANAGEMENT", timeframe: "M15", timing: "WHILE_LIVE", recordedAt: "2026-09-04T13:30:00Z", flags: ["Recorded after execution began"] }),
  galleryItem(ID.m5, { timeframe: "M5", recordedAt: "2026-09-04T12:35:00.000002Z", usedByAi: true }),
  galleryItem(ID.h4, { kind: "LEGACY", label: "HTF", timeframe: "H4", recordedAt: "2026-09-04T12:35:00.000001Z", thumbUrl: `/api/screenshots/${ID.h4}?variant=thumb`, fullUrl: `/api/screenshots/${ID.h4}` }),
  galleryItem(ID.removed, { label: "ENTRY", timing: "WHILE_LIVE", recordedAt: "2026-09-04T13:00:00Z", removed: true }),
];

const element = <P extends object>(component: ComponentType<P>, props: P) => createElement(component, props);
const render = (node: ReactNode, display: TimeDisplay = STRATEGY_TIME) => renderToStaticMarkup(element(TimeDisplayProvider, { value: display, children: node }));

describe("gallery model (spec §7.5)", () => {
  it("groups active screenshots by timing band in band order, oldest first (microsecond exact)", () => {
    const bands = galleryBands(ITEMS);
    expect(bands.map(band => band.label)).toEqual(["Before entry", "While live", "After close"]);
    expect(bands.map(band => band.items.map(item => item.id))).toEqual([[ID.h4, ID.m5], [ID.live], [ID.exit]]);
  });

  it("leaves out removed screenshots and empty bands", () => {
    expect(galleryBands([ITEMS[4]])).toEqual([]);
    expect(galleryBands([ITEMS[0]]).map(band => band.timing)).toEqual(["AFTER_CLOSE"]);
  });

  it("names screenshots like the rest of the app", () => {
    expect(galleryItemName(ITEMS[2])).toBe("M5 chart");
    expect(galleryItemName(ITEMS[3])).toBe("H4 chart");
    expect(galleryItemName(ITEMS[0])).toBe("Exit screenshot");
  });

  it("links screenshots by hash, which the gallery turns back into ids", () => {
    expect(evidenceHref(ID.m5)).toBe(`#evidence-${ID.m5}`);
    expect(EVIDENCE_HASH_PREFIX).toBe("#evidence-");
    expect(evidenceTileId(ID.m5)).toBe(`evidence-${ID.m5}`);
    expect(evidenceIdFromHash(`#evidence-${ID.m5}`)).toBe(ID.m5);
    expect(evidenceIdFromHash("#journal:abc")).toBeNull();
    expect(evidenceIdFromHash("#evidence-")).toBeNull();
    expect(evidenceIdFromHash("#evidence-%E0%A4%A")).toBeNull();
  });

  it("builds gallery items from the trade detail's evidence view", () => {
    const view: EvidenceViewSource = {
      id: ID.m5, kind: "V2", label: "PRE_ENTRY", timeframe: "M5", caption: "  ", timing: "BEFORE_ENTRY", flags: [], recordedAt: "2026-09-04T12:35:00Z",
      removedAt: null, copied: true, copiedFromRecordedAt: "2026-09-03T08:10:00Z", src: `/api/evidence/${ID.m5}`, thumbSrc: `/api/evidence/${ID.m5}?variant=thumb`, width: 1600, height: 900,
    };
    expect(toGalleryItem(view)).toEqual({
      id: ID.m5, kind: "V2", label: "PRE_ENTRY", timeframe: "M5", caption: null, timing: "BEFORE_ENTRY", recordedAt: "2026-09-04T12:35:00Z", removed: false,
      copiedFrom: { recordedAt: "2026-09-03T08:10:00Z" }, thumbUrl: `/api/evidence/${ID.m5}?variant=thumb`, fullUrl: `/api/evidence/${ID.m5}`, width: 1600, height: 900,
      usedByAi: false, flags: [],
    });
    const legacy = { ...view, id: ID.h4, kind: "LEGACY" as const, label: "HTF" as const, timeframe: "H4", copied: false, copiedFromRecordedAt: null, removedAt: "2026-09-04T13:00:00Z" };
    const [first, second] = toGalleryItems([view, legacy], { usedByAi: [ID.h4] });
    expect(first.usedByAi).toBe(false);
    expect(second).toMatchObject({ kind: "LEGACY", timeframe: "H4", removed: true, usedByAi: true });
    expect(second).not.toHaveProperty("copiedFrom");
    expect(toGalleryItem({ ...view, timeframe: "W1" }).timeframe).toBeNull();
  });
});

describe("AI selection (spec §7.5, §11.3)", () => {
  it("toggles ids in selection order up to the per-operation maximum", () => {
    expect(toggleSelection([], "a", 3)).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "c", 3)).toEqual(["a", "b", "c"]);
    expect(toggleSelection(["a", "b", "c"], "d", 3)).toEqual(["a", "b", "c"]);
    expect(toggleSelection(["a", "b", "c"], "b", 3)).toEqual(["a", "c"]);
    expect(toggleSelection(["a", "b", "c", "d"], "e", 3)).toEqual(["a", "b", "c"]);
    expect(toggleSelection(["a"], "b", 0)).toEqual([]);
  });

  it("shares raw evidence ids with AI panels inside the provider, trimmed to the maximum", () => {
    let seen: ReturnType<typeof useEvidenceSelection> | null = null;
    function Probe() {
      seen = useEvidenceSelection();
      return null;
    }
    renderToStaticMarkup(element(EvidenceSelectionProvider, { max: 2, initialSelected: [ID.m5, ID.h4, ID.live, ID.m5], children: createElement(Probe) }));
    expect(seen).not.toBeNull();
    const selection = seen as unknown as ReturnType<typeof useEvidenceSelection>;
    expect(selection.selected).toEqual([ID.m5, ID.h4]);
    expect(selection.max).toBe(2);
    expect(selection.isSelected(ID.h4)).toBe(true);
    expect(selection.isSelected(ID.live)).toBe(false);
  });

  it("requires the provider for AI panels", () => {
    function Orphan() {
      useEvidenceSelection();
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(Orphan))).toThrow(/EvidenceSelectionProvider/);
  });
});

describe("<EvidenceGallery>", () => {
  it("shows the three bands with their exact labels and large thumbnail tiles", () => {
    const markup = render(element(EvidenceGallery, { items: ITEMS, tradeId: TRADE }));
    const positions = ["Before entry", "While live", "After close"].map(label => markup.indexOf(`>${label}<span`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup).toContain(`id="evidence-${ID.m5}"`);
    expect(markup).toContain(`src="/api/evidence/${ID.m5}?variant=thumb"`);
    expect(markup).toContain(`src="/api/screenshots/${ID.h4}?variant=thumb"`);
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain("md:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]");
    expect(markup).toContain("grid-cols-2");
  });

  it("chips label, timeframe and time in words, in the person's time display", () => {
    const strategy = render(element(EvidenceGallery, { items: ITEMS, tradeId: TRADE }));
    expect(strategy).toContain(">Pre-entry<");
    expect(strategy).toContain(">M5<");
    expect(strategy).toContain(">HTF<");
    expect(strategy).toContain(">Management<");
    expect(strategy).toContain('dateTime="2026-09-04T12:35:00.000002Z">07:35</time>');
    expect(strategy).toContain("Closed into the PDH");
    expect(strategy).toContain("Used by AI");
    expect(strategy).toContain("Recorded after execution began");
    expect(strategy).toContain('aria-label="Open M5 chart, recorded 07:35"');
    const utc = render(element(EvidenceGallery, { items: ITEMS, tradeId: TRADE }), { mode: "utc" });
    expect(utc).toContain(">12:35</time>");
  });

  it("never prints ids, codes or removed screenshots in the default view", () => {
    const markup = render(element(EvidenceGallery, { items: ITEMS, tradeId: TRADE }));
    const text = visibleText(markup);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(RAW_CODES);
    expect(markup).not.toContain(`id="evidence-${ID.removed}"`);
    expect(markup).toContain("1 removed screenshot is kept in the timeline.");
    // Ids live in the collapsed Technical details only.
    expect(markup).toMatch(/<details class="disclosure technical-details">[\s\S]*00000000-0000-4000-8000-0000000000f1[\s\S]*<\/details>/);
    expect(render(element(EvidenceGallery, { items: ITEMS, tradeId: TRADE, developerMode: true }))).toMatch(/<details class="disclosure technical-details" open="">/);
  });

  it("offers AI selection inside a provider and marks selected tiles", () => {
    const markup = render(
      element(EvidenceSelectionProvider, { max: 3, initialSelected: [ID.m5], children: element(EvidenceGallery, { items: ITEMS, tradeId: TRADE, selectable: true }) }),
    );
    expect(markup).toContain("Select up to 3 screenshots for AI");
    expect(markup).toContain("1 selected");
    expect(markup).toContain("Selected for AI");
    expect((markup.match(/Selected for AI/g) ?? []).length).toBe(1);
    expect(markup).toContain('aria-label="Use M5 chart (07:35) for AI"');
    const checkboxes = [...markup.matchAll(/<input type="checkbox"[^>]*>/g)].map(match => match[0]);
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes.filter(input => input.includes('checked=""'))).toEqual([expect.stringContaining('aria-label="Use M5 chart (07:35) for AI"')]);
    expect(markup).toContain('aria-label="Open M5 chart, recorded 07:35, selected for AI"');
    expect(markup).toContain("Clear selection");
  });

  it("has no selection controls when not selectable or outside a provider", () => {
    expect(render(element(EvidenceGallery, { items: ITEMS, tradeId: TRADE, selectable: true }))).not.toContain('type="checkbox"');
    const notSelectable = render(element(EvidenceSelectionProvider, { max: 3, initialSelected: [ID.m5], children: element(EvidenceGallery, { items: ITEMS, tradeId: TRADE }) }));
    expect(notSelectable).not.toContain('type="checkbox"');
    expect(notSelectable).not.toContain("Selected for AI");
  });

  it("explains an empty gallery", () => {
    const markup = render(element(EvidenceGallery, { items: [], tradeId: TRADE }));
    expect(markup).toContain("No screenshots yet.");
    expect(markup).toContain("Paste (Ctrl+V), drop or attach chart screenshots. They appear here grouped by when they were recorded.");
    expect(markup).not.toContain("technical-details");
  });

  it("dates tiles when the screenshots span several days", () => {
    const markup = render(element(EvidenceGallery, { items: [ITEMS[2], galleryItem(ID.live, { timing: "WHILE_LIVE", recordedAt: "2026-09-05T13:30:00Z" })], tradeId: TRADE }));
    expect(markup).toContain(">Sep 4, 07:35</time>");
    expect(markup).toContain(">Sep 5, 08:30</time>");
  });
});

describe("<EvidenceViewer> and its details", () => {
  it("renders nothing while closed", () => {
    expect(render(element(EvidenceViewer, { items: ITEMS, index: null, onIndexChange: () => undefined }))).toBe("");
  });

  it("states label, timeframe, timing band and recorded time with its zone", () => {
    const markup = render(element(EvidenceDetails, { item: ITEMS[1] }));
    expect(markup).toContain(">Management<");
    expect(markup).toContain(">M15<");
    expect(markup).toContain(">While live<");
    expect(markup).toContain(">Sep 4, 08:30 UTC−5<");
    expect(markup).toContain("Recorded after execution began");
    expect(visibleText(markup)).not.toMatch(RAW_CODES);
  });

  it("explains copies, AI use, legacy labels and removals", () => {
    const copy = render(element(EvidenceDetails, { item: { ...ITEMS[2], copiedFrom: { recordedAt: "2026-09-03T13:10:00Z" } } }));
    expect(copy).toContain("Copied from an earlier trade · originally recorded Sep 3, 08:10");
    expect(copy).toContain("Used in an AI analysis of this trade");
    expect(render(element(EvidenceDetails, { item: { ...ITEMS[2], copiedFrom: { recordedAt: null } } }))).toContain(">Copied from an earlier trade<");
    expect(render(element(EvidenceDetails, { item: ITEMS[3] }))).toContain("This screenshot&#x27;s label comes from its timeframe and can&#x27;t be edited.");
    expect(render(element(EvidenceDetails, { item: ITEMS[4] }))).toContain("Removed from the gallery. The timeline keeps a record of it.");
    expect(render(element(EvidenceDetails, { item: { ...ITEMS[2], timeframe: null } }))).toContain(">Not set<");
  });

  it("relabels only to labels that fit the timing: Pre-entry is never offered after entry (spec §7.1, §5.3)", () => {
    const labelOptions = (item: GalleryItem) => {
      const markup = render(element(EvidenceRelabelForm, { item, actions: EVIDENCE_ACTIONS, onCancel: () => undefined, onSaved: () => undefined }));
      const labelSelect = markup.slice(markup.indexOf(">Label<"), markup.indexOf(">Timeframe<"));
      return [...labelSelect.matchAll(/<option value="[A-Z_]+"( selected="")?>([^<]+)<\/option>/g)].map(match => `${match[2]}${match[1] ? " (selected)" : ""}`);
    };
    expect(labelOptions(ITEMS[0])).toEqual(["HTF (higher timeframe)", "Context", "Entry", "Exit (selected)", "Other"]);
    expect(labelOptions(ITEMS[1])).toEqual(["HTF (higher timeframe)", "Context", "Entry", "Management (selected)", "Other"]);
    expect(labelOptions(galleryItem(ID.exit, { label: "ENTRY", timing: "AFTER_CLOSE" }))).toEqual(["HTF (higher timeframe)", "Context", "Entry (selected)", "Exit", "Other"]);
    expect(labelOptions(ITEMS[2])).toEqual(["HTF (higher timeframe)", "Context", "Pre-entry (selected)", "Entry", "Other"]);
    // A draft screenshot that became "While live" (entry back-dated) keeps its label selectable, nothing more.
    expect(labelOptions(galleryItem(ID.live, { timing: "WHILE_LIVE" }))).toEqual(["HTF (higher timeframe)", "Context", "Pre-entry (selected)", "Entry", "Management", "Other"]);
    const markup = render(element(EvidenceRelabelForm, { item: ITEMS[0], actions: EVIDENCE_ACTIONS, onCancel: () => undefined, onSaved: () => undefined }));
    expect(markup).toContain("The timing stays After close: relabelling never changes when a screenshot was recorded.");
    expect(visibleText(markup)).not.toMatch(RAW_CODES);
  });

  it("formats times with the shell's time display and never throws on bad input", () => {
    const format = { display: STRATEGY_TIME, time: () => "07:35", dateTime: () => "Sep 4, 07:35", day: () => "Sep 4", zone: () => "UTC−5" };
    expect(recordedTimeText(format, "2026-09-04T12:35:00Z")).toBe("Sep 4, 07:35 UTC−5");
    const broken = { ...format, dateTime: () => { throw new RangeError("Invalid timestamp."); } };
    expect(recordedTimeText(broken, "nope")).toBe("—");
    expect(copiedNoteText(broken, { recordedAt: "nope" })).toBe("Copied from an earlier trade · originally recorded —");
  });
});
