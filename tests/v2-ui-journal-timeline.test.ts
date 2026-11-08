import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GalleryItem } from "@/components/evidence/gallery-model";
import { TradeTimeline, type TradeTimelineProps } from "@/components/trade/journal/timeline";
import { RECORDED_GAP_MINUTES, spansSeveralDays, timelineTime } from "@/components/trade/journal/timeline-model";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import { buildTimeline, type TimelineInputs, type TimelineItem } from "@/domain/timeline";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RAW_CODES = /\b(BEFORE_ENTRY|WHILE_LIVE|AFTER_CLOSE|PRE_ENTRY|POST_TRADE|STOP_CHANGE|TARGET_CHANGE|PARTIAL_CLOSE|RECORDED_AFTER_EXECUTION_BEGAN|EVIDENCE_ADDED|EVIDENCE_REMOVED|AI_ANALYSIS|JOURNAL|COMPLETED|REVIEW_TRADE_TIMELINE)\b/;
const UTC: TimeDisplay = { mode: "utc" };

/** The time as the timeline renders it: the time, then " · recorded …" when the recording time is shown. */
function timelineTimeLabel(item: Pick<TimelineItem, "at" | "recordedAt">, display: TimeDisplay, withDay = false): string {
  const time = timelineTime(item, display, withDay);
  return time.recorded ? `${time.main} · recorded ${time.recorded}` : time.main;
}

const ID = {
  trade: "00000000-0000-4000-8000-000000000001", account: "00000000-0000-4000-8000-000000000002", plan: "00000000-0000-4000-8000-0000000000a1",
  rev1: "00000000-0000-4000-8000-0000000000b1", note1: "00000000-0000-4000-8000-0000000000d1", note2: "00000000-0000-4000-8000-0000000000d2",
  stop: "00000000-0000-4000-8000-0000000000e1", partial: "00000000-0000-4000-8000-0000000000e2", lesson: "00000000-0000-4000-8000-0000000000e3",
  m5: "00000000-0000-4000-8000-0000000000f1", exitShot: "00000000-0000-4000-8000-0000000000f2", ai: "00000000-0000-4000-8000-0000000000a9",
};

function ledger(changes: Partial<LedgerTrade>): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: ID.trade, account_id: ID.account, origin: "PLANNED", created_at: "2026-09-04T11:55:00Z", currency: "USD", revision_count: 1,
    entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 1, journal_count: 5, ai_review_count: 1, ...changes,
  };
}

const INPUTS: TimelineInputs = {
  trade: ledger({
    plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0",
    entered_at: "2026-09-04T12:45:00Z", entry_recorded_at: "2026-09-04T13:20:00Z", entry_price: "1.10005", quantity: "1", planned_quantity: "1", oversize: false,
    exited_at: "2026-09-04T15:00:00Z", close_recorded_at: "2026-09-04T15:05:00Z", exit_price: "1.10345", realized_r: "3.4", net_pnl: "340", outcome: "WIN",
  }),
  instrument: { tickSize: "0.00001", quantityStep: "0.01", quantityUnit: "lots" },
  revisions: [{ proposalId: ID.rev1, revision: 1, createdAt: "2026-09-04T12:00:00Z" }],
  journal: [
    { id: ID.note1, kind: "NOTE", body: "Waiting for the OB retest.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:40:00Z" },
    // Stored before the entry was recorded, but after the back-dated entry time: flagged.
    { id: ID.note2, kind: "NOTE", body: "Filled on the retest.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:50:00Z" },
    { id: ID.stop, kind: "STOP_CHANGE", body: "Protect after the break of structure", details: { price: "1.0995" }, phase: "LIVE", recordedAt: "2026-09-04T13:30:00Z" },
    { id: ID.partial, kind: "PARTIAL_CLOSE", body: null, details: { percent: "50", price: "1.102" }, phase: "LIVE", recordedAt: "2026-09-04T14:00:00Z" },
    { id: ID.lesson, kind: "LESSON", body: "Trust the plan.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-04T15:10:00Z" },
  ],
  evidence: [
    { kind: "V2", id: ID.m5, label: "PRE_ENTRY", timeframe: "M5", caption: "OB on M5", phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:35:00Z", removedAt: null },
    { kind: "V2", id: ID.exitShot, label: "EXIT", timeframe: null, phase: "POST_TRADE", recordedAt: "2026-09-04T15:06:00Z", removedAt: "2026-09-04T15:20:00Z" },
  ],
  aiAnalyses: [{ id: ID.ai, operation: "REVIEW_TRADE_TIMELINE", status: "COMPLETED", recordedAt: "2026-09-04T15:30:00Z", summary: "Disciplined management; the entry came a little early." }],
};

const ITEMS = buildTimeline(INPUTS);

const EVIDENCE: GalleryItem[] = [
  { id: ID.m5, kind: "V2", label: "PRE_ENTRY", timeframe: "M5", caption: "OB on M5", timing: "BEFORE_ENTRY", recordedAt: "2026-09-04T12:35:00Z", thumbUrl: `/api/evidence/${ID.m5}?variant=thumb`, fullUrl: `/api/evidence/${ID.m5}`, width: 1600, height: 900 },
  { id: ID.exitShot, kind: "V2", label: "EXIT", timeframe: null, caption: null, timing: "AFTER_CLOSE", recordedAt: "2026-09-04T15:06:00Z", removed: true, thumbUrl: `/api/evidence/${ID.exitShot}?variant=thumb`, fullUrl: `/api/evidence/${ID.exitShot}`, width: 1600, height: 900 },
];

const element = <P extends object>(component: ComponentType<P>, props: P) => createElement(component, props);
/** React separates adjacent text nodes with `<!-- -->`; drop them to read the text. */
const render = (props: Partial<TradeTimelineProps> = {}) => renderToStaticMarkup(element(TradeTimeline, { items: ITEMS, timeDisplay: STRATEGY_TIME, ...props })).replaceAll("<!-- -->", "");
const visibleText = (markup: string) => {
  const outside = markup.replace(/<details class="disclosure technical-details"[\s\S]*?<\/details>/g, " ");
  return [outside.replace(/<[^>]+>/g, " "), ...[...outside.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1])].join(" ");
};
const itemIds = (markup: string, band: string) => {
  const section = markup.split("<section").find(chunk => chunk.includes(`>${band}<span`)) ?? "";
  return [...section.matchAll(/<li id="([^"]+)"/g)].map(match => match[1]);
};

describe("timeline time rule (spec §5.4)", () => {
  it("adds the recording time only when it is more than five minutes away", () => {
    expect(RECORDED_GAP_MINUTES).toBe(5);
    expect(timelineTimeLabel({ at: "2026-09-04T12:45:00Z", recordedAt: "2026-09-04T13:20:00Z" }, STRATEGY_TIME)).toBe("07:45 · recorded 08:20");
    expect(timelineTimeLabel({ at: "2026-09-04T15:00:00Z", recordedAt: "2026-09-04T15:05:00Z" }, STRATEGY_TIME)).toBe("10:00");
    expect(timelineTimeLabel({ at: "2026-09-04T15:00:00Z", recordedAt: "2026-09-04T15:05:00.000001Z" }, STRATEGY_TIME)).toBe("10:00 · recorded 10:05");
    // Recorded on another day: both times carry their day, so the event is never read as made on the recording day.
    expect(timelineTimeLabel({ at: "2026-09-04T12:45:00Z", recordedAt: "2026-09-05T13:20:00Z" }, UTC)).toBe("Sep 4, 12:45 · recorded Sep 5, 13:20");
    expect(timelineTimeLabel({ at: "2026-09-15T08:15:00Z", recordedAt: "2026-10-31T01:34:00Z" }, STRATEGY_TIME)).toBe("Sep 15, 03:15 · recorded Oct 30, 20:34");
    // 23:58 recorded 00:01 is not shown as recorded (three minutes), so neither time needs its day.
    expect(timelineTimeLabel({ at: "2026-09-05T04:58:00Z", recordedAt: "2026-09-05T05:01:00Z" }, STRATEGY_TIME)).toBe("23:58");
    expect(timelineTimeLabel({ at: "2026-09-04T12:45:00Z", recordedAt: "2026-09-04T13:20:00Z" }, STRATEGY_TIME, true)).toBe("Sep 4, 07:45 · recorded Sep 4, 08:20");
  });

  it("agrees with the domain's own labels in every display", () => {
    for (const display of [STRATEGY_TIME, UTC, { mode: "local", zone: "Asia/Tokyo" } satisfies TimeDisplay]) {
      for (const item of buildTimeline(INPUTS, display)) expect(timelineTimeLabel(item, display)).toBe(item.timeLabel);
    }
  });

  it("describes the full time with its zone for the tooltip", () => {
    expect(timelineTime({ at: "2026-09-04T12:45:00Z", recordedAt: "2026-09-04T13:20:00Z" }, STRATEGY_TIME).full).toBe("Sep 4, 2026, 07:45 UTC−5 · recorded Sep 4, 2026, 08:20");
    expect(timelineTime({ at: "2026-09-04T12:45:00Z", recordedAt: "2026-09-04T12:45:00Z" }, UTC).full).toBe("Sep 4, 2026, 12:45 UTC");
  });

  it("knows when a trade spans several days", () => {
    expect(spansSeveralDays(ITEMS, STRATEGY_TIME)).toBe(false);
    expect(spansSeveralDays([{ at: "2026-09-04T12:00:00Z" }, { at: "2026-09-05T12:00:00Z" }], STRATEGY_TIME)).toBe(true);
    // 04:30 UTC on Sep 5 is still Sep 4 in strategy time.
    expect(spansSeveralDays([{ at: "2026-09-04T12:00:00Z" }, { at: "2026-09-05T04:30:00Z" }], STRATEGY_TIME)).toBe(false);
    expect(spansSeveralDays([{ at: "2026-09-04T12:00:00Z" }, { at: "not a time" }], STRATEGY_TIME)).toBe(false);
    // The recording times shown count too: one day of events recorded on another day still needs dates.
    expect(spansSeveralDays([{ at: "2026-09-15T08:15:00Z", recordedAt: "2026-10-31T01:34:00Z" }, { at: "2026-09-15T11:00:00Z", recordedAt: "2026-09-15T11:00:00Z" }], STRATEGY_TIME)).toBe(true);
    expect(spansSeveralDays([{ at: "2026-09-15T08:15:00Z", recordedAt: "2026-09-15T12:00:00Z" }], STRATEGY_TIME)).toBe(false);
    // A recording time that is not shown (within five minutes) decides nothing.
    expect(spansSeveralDays([{ at: "2026-09-05T04:58:00Z", recordedAt: "2026-09-05T05:01:00Z" }], STRATEGY_TIME)).toBe(false);
  });
});

describe("<TradeTimeline>", () => {
  it("groups items into Before entry, While live and After close, in that order", () => {
    const markup = render();
    const order = ["Before entry", "While live", "After close"].map(label => markup.indexOf(`>${label}<span`));
    expect(order.every(position => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain(">Before entry<");
    expect(markup).toContain(">While live<");
    expect(markup).toContain(">After close<");
    expect(itemIds(markup, "Before entry")).toEqual([`revision:${ID.rev1}`, `plan:${ID.plan}`, `evidence-added:${ID.m5}`, `journal:${ID.note1}`]);
    expect(itemIds(markup, "While live")).toEqual([`entry:${ID.trade}`, `journal:${ID.note2}`, `journal:${ID.stop}`, `journal:${ID.partial}`]);
    expect(itemIds(markup, "After close")).toEqual([`close:${ID.trade}`, `evidence-added:${ID.exitShot}`, `journal:${ID.lesson}`, `evidence-removed:${ID.exitShot}`, `ai:${ID.ai}`]);
  });

  it("uses each item's TimelineItem.id as its DOM id, so source chips can scroll to it", () => {
    const markup = render();
    for (const item of ITEMS) expect(markup).toContain(`<li id="${item.id}"`);
  });

  it("shows exact times, adding the recording time when it is more than five minutes later", () => {
    const markup = render();
    expect(markup).toContain('dateTime="2026-09-04T12:45:00Z" title="Sep 4, 2026, 07:45 UTC−5 · recorded Sep 4, 2026, 08:20"');
    expect(markup).toContain(">07:45<span> · recorded 08:20</span></time>");
    expect(markup).toContain('dateTime="2026-09-04T15:00:00Z" title="Sep 4, 2026, 10:00 UTC−5" class="t-caption num shrink-0">10:00</time>');
    const utc = render({ timeDisplay: UTC });
    expect(utc).toContain(">12:45<span> · recorded 13:20</span></time>");
  });

  it("flags records made after execution began with the exact copy", () => {
    const markup = render();
    expect((markup.match(/Recorded after execution began/g) ?? []).length).toBe(1);
    const flagged = /<li id="journal:[^"]+0d2"[\s\S]*?<\/li>/.exec(markup)?.[0] ?? "";
    expect(flagged).toContain("Recorded after execution began");
    expect(flagged).toContain("Filled on the retest.");
  });

  it("states stop, target and partial details in plain words", () => {
    const markup = render();
    expect(markup).toContain("Stop moved to 1.09950");
    expect(markup).toContain("Protect after the break of structure");
    expect(markup).toContain("Partial close · 50% at 1.10200");
    expect(markup).toContain("Trade opened");
    expect(markup).toContain("Entry 1.10005 · 1.00 lots");
    expect(markup).toContain("Trade closed: +3.40R");
    expect(markup).toContain("Lesson");
  });

  it("keeps removals as records and AI analyses as compact rows", () => {
    const markup = render();
    expect(markup).toContain("Exit screenshot removed");
    const ai = ITEMS.find(item => item.kind === "AI_ANALYSIS") as TimelineItem;
    const row = new RegExp(`<li id="ai:${ID.ai}"[\\s\\S]*?</li>`).exec(markup)?.[0] ?? "";
    expect(row).toContain(ai.title);
    expect(row).toContain(`<p class="min-w-0 flex-1 basis-32 t-meta">${ai.title}</p>`);
    expect(row).toContain('class="relative scroll-mt-24 py-1.5"');
    expect(row).toMatch(/line-clamp-2[^>]*>Disciplined management; the entry came a little early\.</);
  });

  it("shows screenshot thumbnails that open the gallery viewer, but not for removed screenshots", () => {
    const markup = render({ evidence: EVIDENCE });
    expect(markup).toContain(`<a href="#evidence-${ID.m5}"`);
    expect(markup).toContain(`src="/api/evidence/${ID.m5}?variant=thumb"`);
    expect(markup).toContain('alt="Open M5 chart"');
    expect(markup).not.toContain(`href="#evidence-${ID.exitShot}"`);
    expect(markup).toContain("Removed from the gallery later.");
    expect(render()).not.toContain("<img");
  });

  it("keeps ids, codes and details out of the default view, behind collapsed Technical details", () => {
    const markup = render({ evidence: EVIDENCE });
    const text = visibleText(markup);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(RAW_CODES);
    expect(markup).toMatch(/<details class="disclosure technical-details">[\s\S]*journal:00000000-0000-4000-8000-0000000000e1 · JOURNAL\/STOP_CHANGE[\s\S]*details \{&quot;price&quot;:&quot;1.0995&quot;\}/);
    expect(markup).toContain("[RECORDED_AFTER_EXECUTION_BEGAN]");
    expect(render({ developerMode: true })).toContain('<details class="disclosure technical-details" open="">');
  });

  it("dates every time when the trade spans several days", () => {
    const items = buildTimeline({
      ...INPUTS,
      trade: ledger({ plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z", entered_at: "2026-09-04T12:45:00Z", entry_recorded_at: "2026-09-04T12:46:00Z", entry_price: "1.10005" }),
      journal: [{ id: ID.note2, kind: "NOTE", body: "Holding overnight.", details: {}, phase: "LIVE", recordedAt: "2026-09-05T13:00:00Z" }],
      evidence: [], aiAnalyses: [], revisions: [],
    });
    const markup = renderToStaticMarkup(element(TradeTimeline, { items, timeDisplay: STRATEGY_TIME }));
    expect(markup).toContain(">Sep 4, 07:45</time>");
    expect(markup).toContain(">Sep 5, 08:00</time>");
  });

  it("dates an imported entry recorded weeks later, and every other time of that timeline", () => {
    // Imported on Oct 30 (20:34 UTC−5): the platform reported the entry on Sep 15 and the exit the same day.
    const imported = ledger({
      origin: "IMPORTED", created_at: "2026-10-31T01:34:00Z", entered_at: "2026-09-15T08:15:00Z", entry_recorded_at: "2026-10-31T01:34:00Z", entry_price: "1.27",
      exited_at: "2026-09-15T11:00:00Z", close_recorded_at: "2026-10-31T01:34:00Z", exit_price: "1.26", net_pnl: "100", lifecycle: "CLOSED",
    });
    const items = buildTimeline({ trade: imported });
    const markup = renderToStaticMarkup(element(TradeTimeline, { items, timeDisplay: STRATEGY_TIME })).replaceAll("<!-- -->", "");
    expect(markup).toContain(">Sep 15, 03:15<span> · recorded Oct 30, 20:34</span></time>");
    expect(markup).toContain(">Sep 15, 06:00<span> · recorded Oct 30, 20:34</span></time>");
    expect(markup).not.toMatch(/>\d\d:\d\d<span> · recorded/);
  });

  it("shows decisions recorded in V1 with the trader's reason, an override as Taken despite a block", () => {
    const items = buildTimeline({
      trade: ledger({ lifecycle: "DRAFT", legacy_decision: "TAKEN", created_at: "2026-09-04T11:55:00Z" }),
      legacyDecisions: [{
        id: ID.note1, decision: "TAKEN", eventType: "MANUAL_OVERRIDE", reason: "Took it anyway: news was priced in.", riskDecision: "BLOCKED",
        aiDecision: "NOT_EVALUATED", recordedAt: "2026-09-04T12:10:00Z",
      }],
    });
    const markup = renderToStaticMarkup(element(TradeTimeline, { items, timeDisplay: STRATEGY_TIME })).replaceAll("<!-- -->", "");
    const row = new RegExp(`<li id="event:${ID.note1}"[\\s\\S]*?</li>`).exec(markup)?.[0] ?? "";
    expect(row).toContain(">Taken despite a block</p>");
    expect(row).toContain("Took it anyway: news was priced in.");
    expect(row).toContain("lucide-shield-off");
    const text = visibleText(markup);
    expect(text).not.toMatch(/MANUAL_OVERRIDE|HUMAN_DECISION|NOT_EVALUATED/);
    expect(text).not.toMatch(UUID);
    expect(markup).toMatch(/<details class="disclosure technical-details">[\s\S]*LEGACY_DECISION[\s\S]*&quot;eventType&quot;:&quot;MANUAL_OVERRIDE&quot;/);
  });

  it("uses h4 band titles when nested deeper", () => {
    expect(render({ headingLevel: 4 })).toContain("<h4 ");
  });

  it("explains an empty timeline", () => {
    const markup = renderToStaticMarkup(element(TradeTimeline, { items: [], timeDisplay: STRATEGY_TIME }));
    expect(markup).toContain("Nothing recorded yet.");
    expect(markup).toContain("Notes, decisions, stop and target changes and screenshots appear here in the order they happened.");
  });
});
