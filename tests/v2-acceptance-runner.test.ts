import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZip } from "@/lib/zip";
import { type CuratedItem, PUBLISHED, PUBLISHED_GROUPS, publishRefusal, screensReadme } from "../scripts/local-stack/acceptance/curate.mjs";
import { readZip } from "../scripts/local-stack/acceptance/fixtures.mjs";
import {
  acceptanceEmail, type CriterionRecord, clockSpan, deadPoolExpectation, FLOWS, flowStatus, foldInputNotes, fullAnalysisGaps, isFullRun, judgeCriteria, OptionError,
  parseOptions, passMatrix, renderSummary, runIdFor, runVerdict, type ScanRecord, scanVisibleText, screenOf, type StepRecord, strategyClock, UX_CRITERIA,
  widerThanPhone,
} from "../scripts/local-stack/acceptance/rules.mjs";

// Pure rules of the scripted browser acceptance runner (scripts/local-stack/acceptance/run.mjs): options, the strategy
// clock that decides when locks are refused, the visible-text scan for raw internals, the §60 criteria verdicts and the
// summary; plus its ZIP reader, checked against the application's own export writer.

const step = (overrides: Partial<StepRecord>): StepRecord => ({ flow: "planned", viewport: "desktop", id: "s", title: "Step", status: "pass", ms: 1000, ...overrides });

describe("acceptance runner options", () => {
  it("runs every flow at both viewports by default", () => {
    const options = parseOptions([]);
    expect(options.flows).toEqual([...FLOWS]);
    expect(options.viewports).toEqual(["desktop", "mobile"]);
    expect(options).toMatchObject({ out: null, base: "http://127.0.0.1:3000", browser: null, headed: false, publish: false });
  });

  it("keeps selected flows in canonical order without duplicates", () => {
    expect(parseOptions(["--flows=ux,planned,ux"]).flows).toEqual(["planned", "ux"]);
    expect(parseOptions(["--viewport=mobile"]).viewports).toEqual(["mobile"]);
    expect(parseOptions(["--viewport=both", "--publish-screens", "--browser=chrome", "--out=x"])).toMatchObject({ viewports: ["desktop", "mobile"], publish: true, browser: "chrome", out: "x" });
    // `pnpm run acceptance -- --publish-screens` forwards the "--" itself.
    expect(parseOptions(["--", "--publish-screens"]).publish).toBe(true);
  });

  it("rejects unknown flows, viewports, browsers and options with a usage hint", () => {
    expect(() => parseOptions(["--flows=planned,nope"])).toThrow(OptionError);
    expect(() => parseOptions(["--viewport=tablet"])).toThrow(/desktop, mobile or both/);
    expect(() => parseOptions(["--browser=firefox"])).toThrow(/edge or chrome/);
    expect(() => parseOptions(["--unknown"])).toThrow(/Unknown option --unknown/);
    expect(() => parseOptions(["--out="])).toThrow(/needs a value/);
    expect(() => parseOptions(["planned"])).toThrow(/Unexpected argument/);
  });

  it("names users of a run at the reserved example.test domain", () => {
    const runId = runIdFor(new Date("2026-10-24T19:05:12.000Z"), "4F2A!");
    expect(runId).toBe("20261024-190512-4f2a");
    expect(acceptanceEmail(runId, "planned-desktop")).toBe("acc-20261024-190512-4f2a-planned-desktop@example.test");
    expect(acceptanceEmail("RUN", "Mutable Mobile")).toBe("acc-run-mutable-mobile@example.test");
  });
});

describe("strategy clock (fixed UTC−5)", () => {
  it("refuses locks during Dead Pool and says when they are possible again", () => {
    const clock = strategyClock(Date.parse("2026-10-24T18:59:00Z"));
    expect(clock).toMatchObject({ day: "2026-10-24", time: "13:59", session: "Dead Pool", deadPool: true, minutesUntilLocksAllowed: 241 });
  });

  it("names every session at its boundaries", () => {
    const at = (iso: string) => strategyClock(Date.parse(iso)).session;
    expect(at("2026-10-24T05:00:00Z")).toBe("Asia");
    expect(at("2026-10-24T06:00:00Z")).toBe("Judas");
    expect(at("2026-10-24T07:00:00Z")).toBe("Kill zone");
    expect(at("2026-10-24T16:59:59Z")).toBe("Kill zone");
    expect(at("2026-10-24T17:00:00Z")).toBe("Dead Pool");
    expect(at("2026-10-24T23:00:00Z")).toBe("Asia");
    expect(strategyClock(Date.parse("2026-10-24T23:00:00Z")).minutesUntilLocksAllowed).toBe(0);
  });

  it("starts the strategy day at 00:00 UTC−5 and measures the distance to the seed boundaries", () => {
    expect(strategyClock(Date.parse("2026-10-25T04:59:00Z")).day).toBe("2026-10-24");
    expect(strategyClock(Date.parse("2026-10-25T05:00:00Z")).day).toBe("2026-10-25");
    expect(strategyClock(Date.parse("2026-10-24T16:57:00Z")).minutesToSeedBoundary).toBeCloseTo(3, 5);
    expect(strategyClock(Date.parse("2026-10-25T04:50:00Z")).minutesToSeedBoundary).toBeCloseTo(10, 5);
  });

  it("says what the Risk Engine had to answer about Dead Pool for a check inside a window, by the clock alone", () => {
    const at = (iso: string) => Date.parse(iso);
    // 14:00 UTC−5 (19:00 UTC) is deep inside Dead Pool, 19:00 and 09:00 UTC−5 are outside it.
    expect(deadPoolExpectation(at("2026-10-27T19:00:00Z"))).toBe("blocked");
    expect(deadPoolExpectation(at("2026-10-27T19:00:00Z"), at("2026-10-27T19:05:00Z"))).toBe("blocked");
    expect(deadPoolExpectation(at("2026-10-28T00:00:00Z"))).toBe("open");
    expect(deadPoolExpectation(at("2026-10-27T14:00:00Z"), at("2026-10-27T14:10:00Z"))).toBe("open");
    // Within the slack of 12:00 or 18:00 UTC−5 (17:00 and 23:00 UTC), or straddling them, either answer is accepted.
    expect(deadPoolExpectation(at("2026-10-27T16:59:30Z"))).toBe("either");
    expect(deadPoolExpectation(at("2026-10-27T23:00:30Z"))).toBe("either");
    expect(deadPoolExpectation(at("2026-10-27T22:55:00Z"), at("2026-10-27T23:05:00Z"))).toBe("either");
    expect(deadPoolExpectation(at("2026-10-27T16:57:00Z"))).toBe("open");
    expect(deadPoolExpectation(at("2026-10-27T16:57:00Z"), undefined, 5)).toBe("either");
    // The order of the two moments does not matter; a window over a whole Dead Pool is never "open".
    expect(deadPoolExpectation(at("2026-10-27T19:05:00Z"), at("2026-10-27T19:00:00Z"))).toBe("blocked");
    expect(deadPoolExpectation(at("2026-10-27T15:00:00Z"), at("2026-10-28T01:00:00Z"))).toBe("either");
    // Strategy days start at 00:00 UTC−5: a window late on one day and early the next has no Dead Pool boundary.
    expect(deadPoolExpectation(at("2026-10-28T04:50:00Z"), at("2026-10-28T05:10:00Z"))).toBe("open");
  });

  it("names a window in strategy time", () => {
    expect(clockSpan(Date.parse("2026-10-27T23:02:00Z"))).toBe("18:02 UTC−5");
    expect(clockSpan(Date.parse("2026-10-27T23:01:00Z"), Date.parse("2026-10-27T22:59:00Z"))).toBe("17:59–18:01 UTC−5");
  });
});

describe("visible-text scan for raw internals", () => {
  it("accepts ordinary trading copy", () => {
    const copy = [
      "Requested risk 1.00% exceeds your configured maximum of 0.50%.",
      "EURUSD · Long Planned Locked 11:14 · FTMO 100K Model: OB first touch Realized R: +2.95R P&L: +$737.50",
      "Locked 11:17 · Risk Plan V1.0 · ICT V1.0 · immutable",
      "AI usage this month · €0.13 of €10.00 · €9.86 left · resets Nov 1",
      "Duplicate draft · Sources: Trade plan · Your thesis · Live note · 09:45 · M5 chart",
      "No pre-trade plan was recorded before execution.",
    ].join("\n");
    expect(scanVisibleText(copy)).toEqual([]);
  });

  it("finds UUIDs, hashes, provider ids, rule codes, enums, raw JSON and prompt text with context", () => {
    const hits = scanVisibleText([
      "Trade 37b2b883-172c-419e-8604-4a49272a5104 opened",
      `sha ${"a".repeat(64)}`,
      "response resp_0a1b2c3d4e",
      "Blocked: DUPLICATE",
      "Reason RISK_LIMIT and model OB_FIRST_TOUCH",
      'facts {"version": "x"}',
      "You are an AI trading assistant",
    ].join("\n"));
    expect(hits.map(hit => hit.kind)).toEqual(["uuid", "hash", "provider-id", "rule-code", "enum", "enum", "raw-json", "prompt"]);
    expect(hits[0]).toMatchObject({ match: "37b2b883-172c-419e-8604-4a49272a5104" });
    expect(hits[0].context).toContain("Trade 37b2b883");
    expect(scanVisibleText("X_Y ".repeat(50), 5)).toHaveLength(5);
  });

  it("reports screens without ids", () => {
    expect(screenOf("/trades/37b2b883-172c-419e-8604-4a49272a5104/edit")).toBe("/trades/:id/edit");
    expect(screenOf("/journal?account=37b2b883-172c-419e-8604-4a49272a5104")).toBe("/journal");
    expect(screenOf("")).toBe("/");
  });
});

const scan = (screen: string, overflowPx: number, extra: Partial<ScanRecord> = {}): ScanRecord => ({
  screen, viewport: "mobile", theme: "light", flow: "planned", hits: [], selector: "All Accounts", overflowPx, ...extra,
});

describe("phone width", () => {
  it("lists each phone screen wider than the device once per theme, with its largest overflow", () => {
    const wide = widerThanPhone([
      scan("/trades/:id/edit", 5),
      scan("/trades/:id/edit", 21, { widest: 'div.sticky "Save revision" (right edge 414 px)' }),
      scan("/today", 0),
      scan("/today", 1),
      scan("/trades/new", 21),
      scan("/trades/new", 30, { theme: "dark" }),
      scan("/edge", 40, { viewport: "desktop" }),
    ]);
    expect(wide.map(entry => [entry.screen, entry.theme, entry.overflowPx])).toEqual([
      ["/trades/:id/edit", "light", 21],
      ["/trades/new", "dark", 30],
      ["/trades/new", "light", 21],
    ]);
    expect(wide[0].widest).toContain("Save revision");
    expect(widerThanPhone(undefined)).toEqual([]);
  });
});

describe("criteria and pass matrix", () => {
  it("judges each of the 20 criteria from its evidence", () => {
    expect(UX_CRITERIA.map(criterion => criterion.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const verdicts = judgeCriteria([
      { criterion: 3, ok: true, message: "pasted", flow: "planned", viewport: "desktop", step: "paste" },
      { criterion: 4, ok: true, message: "dropped", flow: "planned", viewport: "desktop", step: "drop" },
      { criterion: 4, ok: false, message: "drop refused", flow: "planned", viewport: "mobile", step: "drop" },
    ]);
    expect(verdicts.find(v => v.id === 3)?.verdict).toBe("pass");
    expect(verdicts.find(v => v.id === 4)?.verdict).toBe("fail");
    expect(verdicts.find(v => v.id === 5)?.verdict).toBe("not-run");
  });

  it("fails a flow on any failed step but not on clock-limited ones", () => {
    expect(flowStatus([])).toBe("not-run");
    expect(flowStatus([step({}), step({ status: "clock" }), step({ status: "skipped" })])).toBe("pass");
    expect(flowStatus([step({}), step({ status: "fail" })])).toBe("fail");
    expect(flowStatus([step({ status: "skipped" })])).toBe("skipped");
    const matrix = passMatrix([step({}), step({ status: "clock" }), step({ viewport: "mobile", status: "fail" })], ["planned", "ai"], ["desktop", "mobile"]);
    expect(matrix.planned.desktop).toEqual({ status: "pass", passed: 1, failed: 0, skipped: 0, clock: 1, total: 2 });
    expect(matrix.planned.mobile.status).toBe("fail");
    expect(matrix.ai.desktop.status).toBe("not-run");
  });

  it("renders a summary with the matrix, criteria, failures and clock notes", () => {
    const steps = [
      step({ id: "lock", status: "clock", clockNote: "Dead Pool until 18:00 UTC−5" }),
      step({ id: "close", status: "fail", error: "the trade is closed", screenshots: ["screens/desktop/planned/08-close-failure.png"] }),
    ];
    const summary = renderSummary({
      runId: "run-1", base: "http://127.0.0.1:3000", startedAt: "2026-10-24T19:00:00.000Z", finishedAt: "2026-10-24T19:30:00.000Z", verdict: "fail",
      flows: ["planned"], viewports: ["desktop"], browser: { name: "msedge", version: "1" },
      clock: { start: { day: "2026-10-24", time: "14:00", session: "Dead Pool" }, end: { time: "14:30", session: "Dead Pool" } },
      steps, uxCriteria: judgeCriteria([{ criterion: 19, ok: true, message: "no editor", flow: "planned", viewport: "desktop", step: "locked" }]),
      scans: [scan("/trades/:id/edit", 21, { widest: "div.sticky | Save" }), scan("/today", 0)], warnings: [],
    });
    expect(summary).toContain("| Planned workflow | FAIL 0/2 (1 failed, 1 clock-limited) |");
    expect(summary).toContain("| 19 | Locked plan immutability remains intact. | PASS | no editor [planned/desktop] |");
    expect(summary).toContain("**planned · desktop · close** Step: the trade is closed");
    expect(summary).toContain("screenshot: screens/desktop/planned/08-close-failure.png");
    expect(summary).toContain("planned · desktop · lock: Dead Pool until 18:00 UTC−5");
    expect(summary).toContain("Verdict: **FAIL**");
    expect(summary).toContain("## Phone width (393 px)");
    expect(summary).toContain("- /trades/:id/edit (light): +21 px; widest element div.sticky \\| Save");
    expect(summary).not.toContain("- /today (light)");
  });

  it("fails a step whose phone tap missed its control, and keeps other input notes informational", () => {
    const passed = { status: "pass" as const, error: undefined as string | undefined, evidence: [{ ok: true, message: "the revision is saved" }] };
    const taps = foldInputNotes(passed, [
      { kind: "network", screen: "/today", text: "opening /today failed in the browser (net::ERR_NETWORK_IO_SUSPENDED); retried (attempt 2)" },
      { kind: "tap", screen: "/trades/:id/edit", text: 'a tap on "0.50%" (/trades/:id/edit) landed on another element: the page is 414 px wide on a 393 px screen' },
    ]);
    expect(taps).toHaveLength(1);
    expect(passed.status).toBe("fail");
    expect(passed.error).toBe('a tap on "0.50%" (/trades/:id/edit) landed on another element: the page is 414 px wide on a 393 px screen');
    expect(passed.evidence.map(e => e.ok)).toEqual([true, true, false]);
    expect(passed.evidence[2].message).toMatch(/^phone tap missed its control: a tap on "0\.50%"/);

    // A clock-limited or already failed step fails too; an earlier error is kept in front.
    const limited = { status: "clock" as const, error: undefined as string | undefined, evidence: [] };
    foldInputNotes(limited, [{ kind: "tap", screen: "/today", text: "tap A" }]);
    expect(limited).toMatchObject({ status: "fail", error: "tap A" });
    const failed = { status: "fail" as const, error: "the trade is Live (Draft)", evidence: [] };
    foldInputNotes(failed, [{ kind: "tap", screen: "/today", text: "tap B" }, { kind: "tap", screen: "/today", text: "tap C" }]);
    expect(failed.error).toBe("the trade is Live (Draft); tap B; tap C");

    // Without a tap note nothing changes but the evidence.
    const network = { status: "pass" as const, error: undefined as string | undefined, evidence: [] as { ok: boolean; message: string; info?: boolean }[] };
    expect(foldInputNotes(network, [{ kind: "network", screen: "/edge", text: "retried" }])).toEqual([]);
    expect(network).toEqual({ status: "pass", error: undefined, evidence: [{ ok: true, info: true, message: "retried" }] });
    expect(foldInputNotes(network, undefined)).toEqual([]);
  });

  it("fails a run on a failed step, a failed criterion, or a criterion without evidence in a full run", () => {
    const every = Array.from({ length: 20 }, (_, i): CriterionRecord => ({ criterion: i + 1, ok: true, message: "held", flow: "ux", viewport: "mobile", step: "s" }));
    const all = { flows: [...FLOWS], viewports: ["desktop", "mobile"] };
    expect(isFullRun(all.flows, all.viewports)).toBe(true);
    expect(isFullRun(["planned"], all.viewports)).toBe(false);
    expect(isFullRun(all.flows, ["mobile"])).toBe(false);
    expect(isFullRun(undefined, undefined)).toBe(false);

    expect(runVerdict({ steps: [step({})], criteria: judgeCriteria(every), ...all })).toEqual({ verdict: "pass", reasons: [] });
    expect(runVerdict({ steps: [step({}), step({ status: "fail" }), step({ status: "fail" })], criteria: judgeCriteria(every), ...all }))
      .toEqual({ verdict: "fail", reasons: ["2 steps failed"] });
    // Criterion 7 is judged over every screen of the run: no step fails with it, yet the run must.
    const raw = [...every, { criterion: 7, ok: false, message: "raw internals on /review", flow: "all", viewport: "all", step: null }];
    expect(runVerdict({ steps: [step({})], criteria: judgeCriteria(raw), ...all })).toEqual({ verdict: "fail", reasons: ["criterion 7 failed"] });
    // Criteria that never ran fail a full run only.
    const some = every.filter(record => ![5, 19].includes(record.criterion));
    expect(runVerdict({ steps: [step({})], criteria: judgeCriteria(some), ...all })).toEqual({ verdict: "fail", reasons: ["criteria 5, 19 never ran"] });
    expect(runVerdict({ steps: [step({})], criteria: judgeCriteria(some), flows: ["planned"], viewports: ["mobile"] })).toEqual({ verdict: "pass", reasons: [] });
    expect(runVerdict({ steps: [step({ status: "clock" }), step({ status: "skipped" })], criteria: judgeCriteria(every), ...all }).verdict).toBe("pass");
    expect(runVerdict({ steps: [step({ status: "fail" })], criteria: judgeCriteria(some), ...all, interrupted: true }))
      .toEqual({ verdict: "interrupted", reasons: ["interrupted before every flow ran", "1 step failed", "criteria 5, 19 never ran"] });
  });

  it("lists failed and missing criteria with the verdict's reasons in the summary", () => {
    const records: CriterionRecord[] = [
      { criterion: 5, ok: false, message: 'Edit draft: a tap on "0.25%" (/trades/:id/edit) landed on another element', flow: "ux", viewport: "mobile", step: "edit-blocked-draft" },
      { criterion: 7, ok: true, message: "no raw internals", flow: "all", viewport: "all", step: null },
    ];
    const summary = renderSummary({
      runId: "run-4", base: "http://127.0.0.1:3000", startedAt: "2026-10-28T00:00:00.000Z", verdict: "fail", verdictReasons: ["1 step failed", "criterion 5 failed"],
      flows: [...FLOWS], viewports: ["desktop", "mobile"], steps: [], uxCriteria: judgeCriteria(records), scans: [], warnings: [],
    });
    expect(summary).toContain("- Verdict: **FAIL** (1 step failed; criterion 5 failed)");
    expect(summary).toContain('- **Criterion 5** An unlocked draft can be edited without recreating it. FAILED: Edit draft: a tap on "0.25%" (/trades/:id/edit) landed on another element [ux/mobile]');
    expect(summary).toContain("- **Criterion 1** A trader can identify the next action on a trade within a few seconds. never ran in this full run");
    expect(summary).not.toContain("- **Criterion 7**");
    // A partial run lists no missing criteria.
    const partial = renderSummary({ runId: "run-5", base: "x", startedAt: "2026-10-28T00:00:00.000Z", verdict: "pass", flows: ["ux"], viewports: ["mobile"], steps: [], uxCriteria: judgeCriteria([]), scans: [], warnings: [] });
    expect(partial).not.toContain("never ran");
    expect(partial).toContain("## Failures\n\nNone.");
  });

  it("says when every phone screen fits", () => {
    const summary = renderSummary({ runId: "run-2", base: "http://127.0.0.1:3000", startedAt: "2026-10-24T19:00:00.000Z", flows: [], viewports: ["mobile"], steps: [], scans: [scan("/today", 0)], warnings: [] });
    expect(summary).toContain("Every phone screen scanned fits the device width.");
    expect(renderSummary({ runId: "run-3", base: "x", startedAt: "2026-10-24T19:00:00.000Z", flows: [], viewports: ["desktop"], steps: [], scans: [scan("/today", 0, { viewport: "desktop" })], warnings: [] })).not.toContain("## Phone width");
  });
});

describe("curated screenshots", () => {
  it("publishes 20 to 30 distinct images, each named after its viewport and theme", () => {
    expect(PUBLISHED.length).toBeGreaterThanOrEqual(20);
    expect(PUBLISHED.length).toBeLessThanOrEqual(30);
    expect(new Set(PUBLISHED).size).toBe(PUBLISHED.length);
    for (const name of PUBLISHED) expect(name).toMatch(/^[a-z0-9-]+-(desktop|mobile)(-dark)?$/);
    expect(PUBLISHED_GROUPS.flatMap(group => group.names)).toEqual([...PUBLISHED]);
  });

  it("indexes the images by area, inline, with the run's pass matrix", () => {
    const item = (name: string, title: string, extra: Partial<CuratedItem> = {}): CuratedItem => ({
      name, key: name.replace(/-(desktop|mobile)(-dark)?$/, ""), title, viewport: "desktop", theme: "light", flow: "ux", full: false, screen: "/today", file: `curated/${name}.png`, ...extra,
    });
    const readme = screensReadme([
      item("today-desktop", "Today: session ribbon [all accounts]", { full: true }),
      item("trade-live-mobile-dark", "Dark theme: /trades", { viewport: "mobile", theme: "dark" }),
    ], {
      runId: "20261027-230000-abc123", startedAt: "2026-10-27T23:00:00.000Z", verdict: "pass", clock: { start: { time: "18:00", session: "Asia" } },
      flows: ["planned", "ai"], viewports: ["desktop", "mobile"],
      matrix: { planned: { desktop: { status: "pass", passed: 17, failed: 0, skipped: 0, clock: 0, total: 17 }, mobile: { status: "pass", passed: 16, failed: 0, skipped: 0, clock: 1, total: 17 } } },
    });
    expect(readme).toContain("run `20261027-230000-abc123` (2026-10-27, strategy clock 18:00 UTC−5, Asia; verdict PASS)");
    expect(readme).toContain("- Planned workflow: desktop PASS 17/17, mobile PASS 16/17 (1 clock-limited)");
    expect(readme).toContain("- AI (local mock provider): desktop not run, mobile not run");
    expect(readme).toContain("## Today\n\n**Today: session ribbon [all accounts]** · Desktop 1440×1000 · light theme · whole page\n\n![Today: session ribbon all accounts](today-desktop.png)");
    expect(readme).toContain("## Dark theme\n\n**Dark theme: /trades** · Phone 393×852 · dark theme\n\n![Dark theme: /trades](trade-live-mobile-dark.png)");
    expect(readme).not.toContain("## Planned trade");
    expect(readme).toContain("2 images, each under 480 KB (PNG).");
    expect(readme).toContain("Only a run whose verdict is PASS, covering every flow at both viewports and capturing every image below, replaces");
  });

  it("publishes only from a passing run of every flow at both viewports that captured the whole selection", () => {
    const full = { verdict: "pass", flows: [...FLOWS], viewports: ["desktop", "mobile"] };
    expect(publishRefusal(full, [...PUBLISHED])).toEqual([]);
    expect(publishRefusal({ ...full, verdict: "fail" }, [...PUBLISHED])).toEqual(["the run's verdict is FAIL, not PASS"]);
    expect(publishRefusal({ ...full, verdict: "interrupted" }, [...PUBLISHED])).toEqual(["the run's verdict is INTERRUPTED, not PASS"]);
    expect(publishRefusal({ ...full, flows: ["settings"], viewports: ["mobile"] }, [...PUBLISHED])).toEqual(["the run did not cover every flow at both viewports"]);
    expect(publishRefusal(full, PUBLISHED.filter(name => name !== "today-mobile"))).toEqual(["not captured: today-mobile"]);
    expect(publishRefusal({}, [])).toHaveLength(3);
  });
});

describe("AI card against its full analysis", () => {
  const card = {
    headings: ["Week of Oct 19–25", "Went well", "Needs attention"],
    items: ["You waited for the M5 shift on all three trades.", "The stop moved once after entry, before the plan said it could…"],
  };
  const sheet = {
    headings: ["Week of Oct 19–25", "Summary", "Went well", "Needs attention", "What the AI could not assess"],
    items: [
      "Three trades, all inside the kill zone.",
      "You waited for the M5 shift on all three trades.",
      "The stop moved once after entry, before the plan said it could, which turned a planned 1R loss into 1.4R.",
    ],
  };

  it("accepts a sheet that holds every item of the card in full and more", () => {
    expect(fullAnalysisGaps(card, sheet)).toEqual([]);
    // Sections may carry other names in the sheet: extra items are enough.
    expect(fullAnalysisGaps({ headings: ["Setup analysis", "AI observation"], items: ["A."] }, { headings: ["Setup analysis", "AI observations"], items: ["A."] })).toEqual([]);
  });

  it("names what the sheet lacks", () => {
    expect(fullAnalysisGaps(card, { ...sheet, headings: ["Setup analysis", ...sheet.headings.slice(1)] })).toEqual(['sheet titled "Setup analysis" instead of "Week of Oct 19–25"']);
    expect(fullAnalysisGaps(card, { ...sheet, items: sheet.items.slice(0, 2) })[0]).toMatch(/^items of the card missing from the sheet: "The stop moved once after entry/);
    expect(fullAnalysisGaps(card, { headings: card.headings, items: [...card.items] })).toEqual(["the sheet shows nothing the card does not"]);
    expect(fullAnalysisGaps({ headings: card.headings, items: [card.items[0]] }, { headings: card.headings, items: [card.items[0]] })).toEqual(["the sheet shows nothing the card does not"]);
  });
});

describe("export archive reader", () => {
  it("reads the archive the application writes, byte for byte", () => {
    const image = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
    const archive = createZip([
      { name: "trading-os-export-2026-10-24/core.json", data: '{"user":{"id":"x"}}\n' },
      { name: "trading-os-export-2026-10-24/screenshots/a.png", data: image },
    ]);
    const files = readZip(Buffer.from(archive));
    expect(Object.keys(files)).toEqual(["trading-os-export-2026-10-24/core.json", "trading-os-export-2026-10-24/screenshots/a.png"]);
    expect(files["trading-os-export-2026-10-24/core.json"].toString("utf8")).toBe('{"user":{"id":"x"}}\n');
    expect(Buffer.compare(files["trading-os-export-2026-10-24/screenshots/a.png"], Buffer.from(image))).toBe(0);
  });

  it("also reads deflated entries and rejects corrupt ones", () => {
    const text = Buffer.from("hello hello hello hello");
    const deflated = deflateRawSync(text);
    const name = Buffer.from("a.txt");
    const crc = Buffer.from(createZip([{ name: "a.txt", data: text }])).readUInt32LE(14);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(name.length, 28);
    const centralOffset = local.length + name.length + deflated.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(centralOffset, 16);
    const archive = Buffer.concat([local, name, deflated, central, name, end]);
    expect(readZip(archive)["a.txt"].toString("utf8")).toBe("hello hello hello hello");
    const corrupt = Buffer.from(archive);
    corrupt[local.length + name.length] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow();
    expect(() => readZip(Buffer.from("not a zip at all, definitely not"))).toThrow(/Not a ZIP archive/);
  });
});
