import { describe, expect, it } from "vitest";
import LegacyMonthlyReviewPage from "@/app/edge/monthly/page";
import LegacyRecentTradesReviewPage from "@/app/edge/recent/page";
import LegacyWeeklyReviewPage from "@/app/edge/weekly/page";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contextSwitchHref } from "@/components/review/context-scope";
import type { HistoryEntry } from "@/components/review/history-data";
import { dayLabel, groupByDay } from "@/components/review/history-model";
import {
  decodeHistoryCursor, encodeHistoryCursor, legacyReviewHref, parseReviewQuery, REVIEW_ACCOUNT_PARAM, reviewHref, reviewTabs,
} from "@/components/review/params";
import {
  addMonths, countByMonth, countByWeek, countOrigins, mondayOf, monthPicker, monthsBack, plannedSampleText, plannedSoFarText, sampleText, weekPicker, weekRange, weeksBack,
  weekTitle,
} from "@/components/review/periods";
import { ReviewTabLabel } from "@/components/review/tab-label";

// Review workspace URL state, periods and history grouping (docs/V2_ARCHITECTURE.md §1.2, §11.5, §14.10). Pure.

const NOW = new Date("2026-10-24T08:51:00.000Z"); // Saturday 03:51 UTC−5: the week of Oct 19 is still running.
const ACCOUNT = "20000000-0000-4000-8000-000000000001";

describe("Review URL state (§14.10)", () => {
  it("defaults to the last completed week, the latest 20 trades and the last completed month", () => {
    const query = parseReviewQuery("weekly", {}, NOW);
    expect(query).toMatchObject({
      tab: "weekly", week: "2026-10-12", month: "2026-09", sample: 20, explicitPeriod: false, periodInvalid: false, kind: "all", before: null,
      reviewAccount: null, reviewAccountInvalid: false,
    });
    // On the 1st (UTC−5) the month that just ended is the default; the evening before is still in the old month.
    expect(parseReviewQuery("monthly", {}, new Date("2026-11-01T05:00:00Z")).month).toBe("2026-10");
    expect(parseReviewQuery("monthly", {}, new Date("2026-11-01T04:59:59Z")).month).toBe("2026-09");
    // Monday 00:00 UTC−5 completes the previous week.
    expect(parseReviewQuery("weekly", {}, new Date("2026-10-19T05:00:00Z")).week).toBe("2026-10-12");
    expect(parseReviewQuery("weekly", {}, new Date("2026-10-19T04:59:59Z")).week).toBe("2026-10-05");
  });

  it("normalises any day to its Monday and keeps an explicit period", () => {
    expect(parseReviewQuery("weekly", { week: "2026-10-15" }, NOW)).toMatchObject({ week: "2026-10-12", explicitPeriod: true, periodInvalid: false });
    expect(parseReviewQuery("monthly", { month: "2026-08" }, NOW)).toMatchObject({ month: "2026-08", explicitPeriod: true });
    expect(parseReviewQuery("recent", { sample: "30" }, NOW)).toMatchObject({ sample: 30, explicitPeriod: true });
    // Repeated parameters keep the last value, like the Journal filters.
    expect(parseReviewQuery("weekly", { week: ["2026-09-01", "2026-10-01"] }, NOW).week).toBe("2026-09-28");
  });

  it("flags unreadable periods and falls back to the defaults instead of failing", () => {
    expect(parseReviewQuery("weekly", { week: "2026-13-40" }, NOW)).toMatchObject({ week: "2026-10-12", explicitPeriod: false, periodInvalid: true });
    expect(parseReviewQuery("monthly", { month: "September" }, NOW)).toMatchObject({ month: "2026-09", periodInvalid: true });
    expect(parseReviewQuery("recent", { sample: "15" }, NOW)).toMatchObject({ sample: 20, periodInvalid: true });
    // A period of another tab is not this tab's concern.
    expect(parseReviewQuery("weekly", { sample: "15" }, NOW).periodInvalid).toBe(false);
  });

  it("reads the in-page account choice separately from the account context (?account= belongs to the proxy)", () => {
    expect(parseReviewQuery("weekly", { [REVIEW_ACCOUNT_PARAM]: ACCOUNT.toUpperCase(), account: "all" }, NOW)).toMatchObject({ reviewAccount: ACCOUNT, reviewAccountInvalid: false });
    expect(parseReviewQuery("weekly", { reviewAccount: "FTMO" }, NOW)).toMatchObject({ reviewAccount: null, reviewAccountInvalid: true });
  });

  it("builds stable links: defaults are left out and the account goes last", () => {
    expect(reviewHref("weekly")).toBe("/review/weekly");
    expect(reviewHref("weekly", { week: "2026-10-12", reviewAccount: ACCOUNT })).toBe(`/review/weekly?week=2026-10-12&reviewAccount=${ACCOUNT}`);
    expect(reviewHref("recent", { sample: 10, week: "2026-10-12" })).toBe("/review/recent?sample=10");
    expect(reviewHref("monthly", { month: "2026-09" })).toBe("/review/monthly?month=2026-09");
    expect(reviewHref("history", { kind: "all" })).toBe("/review/history");
    expect(reviewHref("history", { kind: "trade", before: "abc" })).toBe("/review/history?kind=trade&before=abc");
  });

  it("keeps the in-page account on the periodic tabs; History opens on every account", () => {
    const tabs = reviewTabs("recent", ACCOUNT);
    expect(tabs.map(tab => [tab.label, tab.href, tab.current])).toEqual([
      ["Weekly", `/review/weekly?reviewAccount=${ACCOUNT}`, false],
      ["Recent trades", `/review/recent?reviewAccount=${ACCOUNT}`, true],
      ["Monthly", `/review/monthly?reviewAccount=${ACCOUNT}`, false],
      ["History", "/review/history", false],
    ]);
    expect(reviewTabs("history", null).map(tab => tab.href)).toEqual(["/review/weekly", "/review/recent", "/review/monthly", "/review/history"]);
  });

  it("shortens 'Recent trades' on phones so all four tabs fit, keeping the full label as the accessible name", () => {
    expect(reviewTabs("history", null).map(tab => tab.shortLabel)).toEqual([null, "Recent", null, null]);
    for (const tab of reviewTabs("history", null)) {
      // Each short label starts the full label, so the accessible name contains what a phone shows (WCAG 2.5.3).
      if (tab.shortLabel) expect(tab.label.startsWith(tab.shortLabel)).toBe(true);
    }
    expect(renderToStaticMarkup(createElement(ReviewTabLabel, { label: "Recent trades", shortLabel: "Recent" }))).toBe(
      '<span aria-hidden="true" class="sm:hidden">Recent</span><span class="max-sm:sr-only">Recent trades</span>',
    );
    expect(renderToStaticMarkup(createElement(ReviewTabLabel, { label: "History", shortLabel: null }))).toBe("History");
  });

  it("round-trips the history cursor and rejects anything it did not write", () => {
    const cursor = { t: "2026-10-23T18:45:53.308382+00:00", id: "71000000-0000-4000-8000-000000000001" };
    const encoded = encodeHistoryCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHistoryCursor(encoded)).toEqual(cursor);
    expect(decodeHistoryCursor(undefined)).toBeNull();
    expect(decodeHistoryCursor("not a cursor!")).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor({ t: "yesterday", id: cursor.id }))).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor({ t: cursor.t, id: "x" }))).toBeNull();
    const extra = Buffer.from(JSON.stringify({ ...cursor, sql: "drop" })).toString("base64url");
    expect(decodeHistoryCursor(extra)).toBeNull();
    expect(decodeHistoryCursor("a".repeat(301))).toBeNull();
  });
});

describe("links that switch the trading-account context load in full (§9.2)", () => {
  const BASE = "http://127.0.0.1:3000/review/weekly?reviewAccount=x";
  const OTHER = "20000000-0000-4000-8000-000000000002";

  it("returns the full address of a same-origin link that names another context", () => {
    expect(contextSwitchHref(`/journal?closedFrom=2026-10-12&closedTo=2026-10-18&account=${ACCOUNT}`, "all", BASE)).toBe(
      `http://127.0.0.1:3000/journal?closedFrom=2026-10-12&closedTo=2026-10-18&account=${ACCOUNT}`,
    );
    expect(contextSwitchHref(`/settings?account=${ACCOUNT}#ai`, "all", BASE)).toBe(`http://127.0.0.1:3000/settings?account=${ACCOUNT}#ai`);
    expect(contextSwitchHref("/review/history?account=all", ACCOUNT, BASE)).toBe("http://127.0.0.1:3000/review/history?account=all");
    expect(contextSwitchHref(`/settings?account=${OTHER}#ai`, ACCOUNT, BASE)).toBe(`http://127.0.0.1:3000/settings?account=${OTHER}#ai`);
    // The proxy reads the value case-insensitively and takes the first one.
    expect(contextSwitchHref(`/journal?account=${ACCOUNT.toUpperCase()}`, "all", BASE)).toBe(`http://127.0.0.1:3000/journal?account=${ACCOUNT.toUpperCase()}`);
    expect(contextSwitchHref(`/journal?account=all&account=${ACCOUNT}`, ACCOUNT, BASE)).toBe(`http://127.0.0.1:3000/journal?account=all&account=${ACCOUNT}`);
  });

  it("leaves every other link to the client-side router", () => {
    // Same context: nothing changes in the header.
    expect(contextSwitchHref(`/settings?account=${ACCOUNT}#ai`, ACCOUNT, BASE)).toBeNull();
    expect(contextSwitchHref(`/settings?account=${ACCOUNT.toUpperCase()}#ai`, ACCOUNT, BASE)).toBeNull();
    expect(contextSwitchHref("/review/history?account=ALL", "all", BASE)).toBeNull();
    // No context parameter: in-page choices, tabs, periods, trades.
    expect(contextSwitchHref(`/review/weekly?week=2026-10-05&reviewAccount=${ACCOUNT}`, "all", BASE)).toBeNull();
    expect(contextSwitchHref("/journal?closedFrom=2026-10-12&closedTo=2026-10-18", ACCOUNT, BASE)).toBeNull();
    expect(contextSwitchHref("/trades/a0000000-0000-4000-8000-000000000001", "all", BASE)).toBeNull();
    expect(contextSwitchHref("#ai", "all", BASE)).toBeNull();
    // A value the proxy ignores does not switch anything.
    expect(contextSwitchHref("/journal?account=FTMO", "all", BASE)).toBeNull();
    expect(contextSwitchHref("/journal?account=", "all", BASE)).toBeNull();
    // Other origins and unreadable addresses keep the browser's behaviour.
    expect(contextSwitchHref(`https://example.com/journal?account=${ACCOUNT}`, "all", BASE)).toBeNull();
    expect(contextSwitchHref("http://[bad", "all", BASE)).toBeNull();
  });
});

describe("legacy review URLs (§1.2)", () => {
  it("maps /edge/weekly|recent|monthly to /review/* with the same parameters", () => {
    expect(legacyReviewHref("weekly", {})).toBe("/review/weekly");
    expect(legacyReviewHref("weekly", { account: ACCOUNT, week: "2026-10-14", page: "2" })).toBe(`/review/weekly?account=${ACCOUNT}&week=2026-10-14&page=2`);
    expect(legacyReviewHref("recent", { sample: "30", tag: ["a b", "c&d"] })).toBe("/review/recent?sample=30&tag=a+b&tag=c%26d");
    expect(legacyReviewHref("monthly", { month: "2026-09", empty: undefined })).toBe("/review/monthly?month=2026-09");
  });

  async function redirectTarget(page: Promise<unknown>): Promise<string> {
    try {
      await page;
    } catch (error) {
      const digest = (error as { digest?: unknown }).digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2];
      throw error;
    }
    throw new Error("The legacy page rendered instead of redirecting.");
  }

  it("redirects the legacy pages, query string preserved (never a 404 for a bookmark)", async () => {
    const searchParams = Promise.resolve({ account: ACCOUNT, week: "2026-10-14" });
    expect(await redirectTarget(LegacyWeeklyReviewPage({ searchParams }))).toBe(`/review/weekly?account=${ACCOUNT}&week=2026-10-14`);
    expect(await redirectTarget(LegacyRecentTradesReviewPage({ searchParams: Promise.resolve({ sample: "10" }) }))).toBe("/review/recent?sample=10");
    expect(await redirectTarget(LegacyMonthlyReviewPage({ searchParams: Promise.resolve({}) }))).toBe("/review/monthly");
  });
});

describe("review periods (fixed UTC−5)", () => {
  it("labels weeks and months the way the periodic reviews scope them", () => {
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
    expect(weekRange("2026-10-12")).toBe("Oct 12–18");
    expect(weekRange("2026-09-28")).toBe("Sep 28–Oct 4");
    expect(weekRange("2026-12-28", "2026")).toBe("Dec 28–Jan 3, 2027");
    expect(weekTitle("2026-10-12")).toBe("Week of Oct 12–18");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(weeksBack("2026-10-12", "2026-09-28", 52)).toEqual(["2026-10-12", "2026-10-05", "2026-09-28"]);
    expect(monthsBack("2026-09", "2026-07", 1)).toEqual(["2026-09"]);
    expect(sampleText(0)).toBe("nothing to review");
    expect(sampleText(1)).toBe("1 trade");
    expect(sampleText(5)).toBe("5 trades");
    expect(plannedSampleText(0)).toBe("nothing to review");
    expect(plannedSampleText(1)).toBe("1 planned trade");
    expect(plannedSampleText(5)).toBe("5 planned trades");
    // A running period is counted so far, never as a final sample.
    expect(plannedSoFarText(0)).toBe("no planned trades so far");
    expect(plannedSoFarText(1)).toBe("1 planned trade so far");
    expect(plannedSoFarText(3)).toBe("3 planned trades so far");
  });

  it("counts closed trades by exit time in UTC−5, separating what a review covers", () => {
    const trades = [
      { origin: "PLANNED" as const, exited_at: "2026-10-19T04:59:59Z" }, // Sunday 23:59 UTC−5: still the week of Oct 12
      { origin: "PLANNED" as const, exited_at: "2026-10-19T05:00:00Z" }, // Monday 00:00 UTC−5: the next week
      { origin: "LIVE_FIRST" as const, exited_at: "2026-10-14T15:00:00Z" },
      { origin: "IMPORTED" as const, exited_at: "2026-10-01T04:00:00Z" }, // Sep 30 23:00 UTC−5
    ];
    const weeks = countByWeek(trades);
    expect(weeks.get("2026-10-12")).toEqual({ planned: 1, liveFirst: 1, imported: 0 });
    expect(weeks.get("2026-10-19")).toEqual({ planned: 1, liveFirst: 0, imported: 0 });
    expect(weeks.get("2026-09-28")).toEqual({ planned: 0, liveFirst: 0, imported: 1 });
    const months = countByMonth(trades);
    expect(months.get("2026-09")).toEqual({ planned: 0, liveFirst: 0, imported: 1 });
    expect(months.get("2026-10")).toEqual({ planned: 2, liveFirst: 1, imported: 0 });
    expect(countOrigins(trades)).toEqual({ planned: 2, liveFirst: 1, imported: 1 });
  });

  it("lists completed weeks since the account started, with counts and review marks", () => {
    const picker = weekPicker({
      selected: "2026-10-12", lastCompleted: "2026-10-12", earliest: "2026-09-28", counts: countByWeek([{ origin: "PLANNED", exited_at: "2026-10-14T15:00:00Z" }]),
      reviewed: new Set(["2026-10-12"]), currentYear: "2026", href: week => `/w/${week}`,
    });
    expect(picker.label).toBe("Week");
    expect(picker.options.map(option => option.label)).toEqual(["Oct 12–18 · 1 trade · reviewed", "Oct 5–11 · nothing to review", "Sep 28–Oct 4 · nothing to review"]);
    expect(picker.previous).toEqual({ href: "/w/2026-10-05", label: "Previous week, Oct 5–11" });
    expect(picker.next).toBeNull();
  });

  it("keeps an out-of-list selection, marks an unfinished week, and never claims 'nothing to review' when counts failed", () => {
    const future = weekPicker({
      selected: "2026-10-19", lastCompleted: "2026-10-12", earliest: "2026-10-12", counts: null, reviewed: new Set(), currentYear: "2026", href: week => week,
    });
    expect(future.options.map(option => option.label)).toEqual(["Oct 19–25 · not finished", "Oct 12–18"]);
    expect(future.next).toBeNull();
    expect(future.previous?.href).toBe("2026-10-12");
    const first = weekPicker({ selected: "2026-10-12", lastCompleted: "2026-10-19", earliest: "2026-10-12", counts: null, reviewed: new Set(), currentYear: "2026", href: week => week });
    expect(first.previous).toBeNull();
    expect(first.next?.label).toBe("Next week, Oct 19–25");
  });

  it("lists completed months the same way", () => {
    const picker = monthPicker({
      selected: "2026-09", lastCompleted: "2026-09", earliest: "2026-07", counts: countByMonth([{ origin: "PLANNED", exited_at: "2026-09-08T15:00:00Z" }]),
      reviewed: new Set(["2026-09"]), currentYear: "2026", href: month => `/m/${month}`,
    });
    expect(picker.options.map(option => option.label)).toEqual(["September 2026 · 1 trade · reviewed", "August 2026 · nothing to review", "July 2026 · nothing to review"]);
    expect(picker.previous).toEqual({ href: "/m/2026-08", label: "Previous month, August 2026" });
    expect(picker.next).toBeNull();
  });
});

describe("history grouping", () => {
  const entry = (requestedAt: string, completedAt: string | null, id: string): HistoryEntry => ({
    operation: "WEEKLY_REVIEW", operationLabel: "Weekly Review", status: completedAt ? "COMPLETED" : "IN_PROGRESS", statusLabel: completedAt ? "Completed" : "In progress",
    requestedAt, completedAt, label: "", headline: null, failureReason: null, accountingNote: null, accountId: ACCOUNT, revision: null,
    subject: { label: "Week of Oct 12–18", href: "/review/weekly?week=2026-10-12", kind: "period" },
    technical: {
      requestId: id, operation: "WEEKLY_REVIEW", operationVersion: null, contract: null, provider: null, model: null, errorCode: null, reservationId: null,
      reservedMicros: null, chargedMicros: null, disposition: null, inputTokens: null, outputTokens: null, responseId: null,
    },
  });

  it("labels days relative to today in the trader's display", () => {
    expect(dayLabel("2026-10-24", "2026-10-24")).toBe("Today");
    expect(dayLabel("2026-10-23", "2026-10-24")).toBe("Yesterday");
    expect(dayLabel("2026-10-21", "2026-10-24")).toBe("Wed, Oct 21");
    expect(dayLabel("2025-12-30", "2026-10-24")).toBe("Tue, Dec 30, 2025");
  });

  it("groups consecutive entries by the day they finished (or were requested) and shows their time", () => {
    const groups = groupByDay(
      [
        entry("2026-10-24T08:40:00Z", null, "a"),
        entry("2026-10-23T18:45:00Z", "2026-10-23T18:46:00Z", "b"),
        entry("2026-10-23T14:00:00Z", "2026-10-23T14:01:00Z", "c"),
        entry("2026-10-02T15:00:00Z", "2026-10-02T15:01:00Z", "d"),
      ],
      NOW.toISOString(),
      { mode: "strategy" },
    );
    expect(groups.map(group => [group.label, group.entries.map(item => `${item.technical.requestId} ${item.time}`)])).toEqual([
      ["Today", ["a 03:40"]],
      ["Yesterday", ["b 13:46", "c 09:01"]],
      ["Fri, Oct 2", ["d 10:01"]],
    ]);
    // UTC display moves the boundary: 03:40 UTC−5 is 08:40 UTC, still Oct 24.
    expect(groupByDay([entry("2026-10-24T02:00:00Z", "2026-10-24T02:00:00Z", "e")], NOW.toISOString(), { mode: "utc" })[0].label).toBe("Today");
    expect(groupByDay([entry("2026-10-24T02:00:00Z", "2026-10-24T02:00:00Z", "e")], NOW.toISOString(), { mode: "strategy" })[0].label).toBe("Yesterday");
  });

  it("keeps keys unique when a day appears twice and survives an unreadable time", () => {
    const groups = groupByDay(
      [entry("2026-10-23T12:00:00Z", "2026-10-23T12:00:00Z", "a"), entry("2026-10-22T12:00:00Z", "2026-10-22T12:00:00Z", "b"), entry("2026-10-23T11:00:00Z", "2026-10-23T11:00:00Z", "c"), entry("bad", null, "d")],
      NOW.toISOString(),
      { mode: "strategy" },
    );
    expect(groups.map(group => group.key)).toEqual(["2026-10-23", "2026-10-22", "2026-10-23#2", "unknown"]);
    expect(groups[3]).toMatchObject({ label: "Earlier", day: null });
    expect(groups[3].entries[0].time).toBeNull();
  });
});
