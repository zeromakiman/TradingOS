import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRibbon, nextTransition, sessionSegments } from "@/components/session-ribbon";
import { StatusBanner } from "@/components/status-banner";
import { rTone } from "@/components/numeric";
import { strategyClock } from "@/domain/session";
import { formatR } from "@/domain/ux";

const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/journal-data", () => ({ loadJournalPage: mock.load }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/setup-journal", () => ({ SetupJournal: () => null }));
vi.mock("@/components/account-setup", () => ({ AccountSetup: () => null }));
vi.mock("@/components/forms", () => ({ Field: ({ label, children }: { label: string; children: ReactNode }) => createElement("label", null, label, children) }));
import JournalPage from "@/app/journal/page";

const account = { id: "11111111-1111-4111-8111-111111111111", name: "Synthetic review" };
const row = (n: number, locked_at: string) => ({ id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`, locked_at, instrument: "EURUSD", direction: "LONG", entry_model: "OTE", strategy_version: "ICT V1.0", status: "CLOSED", initial_risk: "50", risk_percent: "0.5", realized_r: "1", outcome: "WIN", execution_id: "synthetic" });
beforeEach(() => vi.clearAllMocks());

describe("independent rendered Journal acceptance", () => {
  it("retains every row in query order across the strategy midnight and a partial day", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i, i < 49 ? "2026-09-16T05:00:00.000001Z" : "2026-09-16T04:59:59.999999Z"));
    mock.load.mockResolvedValue({ account, accounts: [account], rows, count: 51, plannedRR: new Map(rows.map(r => [r.id, "3"])) });
    const html = renderToStaticMarkup(await JournalPage({ searchParams: Promise.resolve({ account: account.id }) }));
    const links = [...html.matchAll(/href="\/journal\/([0-9a-f-]+)\?/g)].map(m => m[1]);
    expect(links).toEqual(rows.map(r => r.id));
    expect(new Set(links).size).toBe(50);
    expect(html).toContain("2026-09-16 · UTC−5");
    expect(html).toContain("2026-09-15 · UTC−5");
    expect(html).toContain("51 matching trades");
    expect(html).toContain("Older →");
    expect(html).not.toContain("← Newer");
    expect([...html.matchAll(/class="record-day">([\s\S]*?)<\/div>/g)].every(m => !/trades|net R|records/i.test(m[1]))).toBe(true);
  });

  it("preserves filters and paging in both the loader and return navigation", async () => {
    mock.load.mockResolvedValue({ account, accounts: [account], rows: [row(51, "2026-09-15T12:00:00Z")], count: 51, plannedRR: new Map() });
    const html = renderToStaticMarkup(await JournalPage({ searchParams: Promise.resolve({ account: account.id, page: "1", status: "CLOSED", from: "2026-09-15", to: "2026-09-16", q: "EURUSD" }) }));
    expect(mock.load).toHaveBeenCalledWith(account.id, expect.objectContaining({ page: 1, status: "CLOSED", from: "2026-09-15", to: "2026-09-16", q: "EURUSD" }));
    expect(html).toContain("← Newer");
    expect(html).not.toContain("Older →");
    expect(html).toContain("page%3D1");
    expect(html).toContain("status%3DCLOSED");
    expect(html).toContain("Page 2 · 50 per page");
  });
});

describe("independent presentation boundary acceptance", () => {
  it.each(["2026-12-31T23:59:59.999-05:00", "2026-03-08T00:30:24-05:00", "2026-11-01T23:30:45-05:00"])("keeps the first distinct session across calendar/DST boundaries at %s", instant => {
    const current = strategyClock(instant), next = nextTransition(instant);
    expect(next).not.toBeNull();
    if (!next) throw new Error("Missing transition");
    const boundary = new Date(`${next.day}T${next.time}:00-05:00`);
    expect(strategyClock(boundary).session).toBe(next.session);
    expect(strategyClock(new Date(boundary.getTime() - 1)).session).toBe(current.session);
    const html = renderToStaticMarkup(createElement(SessionRibbon, { now: instant }));
    expect(html).toContain(next.time);
    if (next.day !== current.day) expect(html).toContain(next.day);
    const segments = sessionSegments(current.day);
    expect(segments[0].from).toBe(0);
    const last = segments.at(-1);
    if (!last) throw new Error("Missing day segments");
    expect(last.from + last.span).toBe(1440);
  });

  it("renders the authoritative active label and binding reasons together", () => {
    const label = "TRADE ACTIVE", reason = "Update today’s account values in Settings before locking a plan.";
    const html = renderToStaticMarkup(createElement(StatusBanner, { label, reasons: [reason], clock: "06:00 UTC−5", note: "Existing trades remain manageable.", readout: [] }));
    expect(html).toContain("is-restricted");
    expect(html).toContain(label);
    expect(html).toContain(reason);
    expect(html).toContain("NEW LOCKS RESTRICTED");
  });

  it.each(["0.00001", "-0.00001", "-0", "999999999999.123456", null])("does not reinterpret or alter formatted R for %s", value => {
    const formatted = formatR(value), tone = rTone(formatted);
    expect(formatR(value)).toBe(formatted);
    expect(tone).toBe(formatted.startsWith("+") ? "success" : formatted.startsWith("-") ? "red" : "muted");
  });
});
