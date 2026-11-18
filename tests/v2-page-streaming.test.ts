import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ trades: vi.fn(), session: vi.fn(), ready: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/app/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/actions/context", () => ({ setAccountContext: vi.fn(), setTheme: vi.fn(), setTimeDisplay: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: vi.fn() }));
vi.mock("@/lib/account-context", () => ({
  currentSession: m.session,
  getAccountContext: async () => ({ accounts: [], noticeText: null }),
  getPreferences: async () => ({ timeDisplay: { mode: "strategy" }, theme: "system" }),
  shellAccounts: () => [], shellSelection: () => ({ mode: "all" }),
}));
vi.mock("@/lib/schema-gate", () => ({ getSchemaStatus: async () => ({ ready: m.ready }), SCHEMA_OUTDATED_TITLE: "Database update required", SCHEMA_OUTDATED_MESSAGE: "Update first" }));
vi.mock("@/lib/trades-data", () => ({ loadPaletteTrades: m.trades }));
// DOM/portal behavior is covered by v2-ui-shell; here the real layout owns the async boundary.
vi.mock("@/components/shell/app-shell", () => ({ AppShell: ({ children, palette }: { children: ReactNode; palette: ReactNode }) => createElement("main", null, "Shell navigation", children, palette) }));
vi.mock("@/components/shell/command-palette", () => ({ CommandPalette: ({ tradeData, tradesLoading, tradesUnavailable, index }: { tradeData?: Promise<unknown>; tradesLoading?: boolean; tradesUnavailable?: boolean; index: { recentTrades: { symbol: string }[] } }) => createElement("aside", null, tradeData || tradesLoading ? "Loading trades" : tradesUnavailable ? "Trade search is unavailable" : index.recentTrades.map(t => t.symbol).join(",")) }));

import AppLayout from "@/app/(app)/layout";

beforeEach(() => {
  m.ready = true;
  m.trades.mockReset();
  m.session.mockResolvedValue({ db: {}, user: { id: "current-user", email: "trader@example.com" } });
});

it("renders shell and route while the palette index promise remains pending", async () => {
  let release!: (value: { liveTrades: never[]; recentTrades: { symbol: string }[] }) => void;
  m.trades.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const element = await AppLayout({ children: createElement("h1", null, "Today core") });
  const stream = await renderToReadableStream(element);
  const reader = stream.getReader();
  let html = new TextDecoder().decode((await reader.read()).value);
  expect(html).toContain("Shell navigation");
  expect(html).toContain("Today core");
  expect(html).toContain("Loading trades");
  expect(html).not.toContain("EURUSD");
  release({ liveTrades: [], recentTrades: [{ symbol: "EURUSD" }] });
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    html += new TextDecoder().decode(next.value);
  }
  await expect(element.props.palette.props.tradeData).resolves.toEqual({ liveTrades: [], recentTrades: [{ symbol: "EURUSD" }] });
  expect(m.trades).toHaveBeenCalledTimes(1);
  expect(m.trades).toHaveBeenCalledWith(expect.objectContaining({ userId: "current-user", scope: { mode: "all" } }));
});

it("keeps shell and route usable after palette failure without pretending the index is empty", async () => {
  m.trades.mockRejectedValue(new Error("unavailable"));
  const element = await AppLayout({ children: "Today core" });
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("Today core");
  await expect(element.props.palette.props.tradeData).resolves.toBeNull();
});

it("preserves authentication and schema gates before any palette loading", async () => {
  m.session.mockRejectedValueOnce(new Error("authentication required"));
  await expect(AppLayout({ children: "Private page" })).rejects.toThrow("authentication required");
  expect(m.trades).not.toHaveBeenCalled();
  m.ready = false;
  const stream = await renderToReadableStream(await AppLayout({ children: "Private page" }));
  const html = await new Response(stream).text();
  expect(html).toContain("Database update required");
  expect(html).not.toContain("Private page");
  expect(m.trades).not.toHaveBeenCalled();
});
