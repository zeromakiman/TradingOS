import { beforeEach, describe, expect, it, vi } from "vitest";

// Today's losses (docs/V2_ARCHITECTURE.md §14.1, §3.2, §6.2): in All Accounts the summary's "Realized losses today"
// covers the same accounts as "Today's result". An archived account still closes the positions it holds, and the result
// counts those trades, so the loader adds that account's losses from its own daily usage (realized and external), as a
// status row's come from its workspace. The trade list, the decoration and the usage reads are doubles: this checks what
// `loadToday` asks for and sums, not the SQL (the engine's `private.daily_usage` has its own database tests).

const m = vi.hoisted(() => ({
  closed: [] as unknown[],
  usage: new Map<string, Record<string, string | number | null>>(),
  loadDailyUsage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-context", () => ({ currentSession: vi.fn(), getAccountContext: vi.fn() }));
vi.mock("@/lib/performance-data", () => ({ loadLedgerRows: async () => ({ rows: m.closed, truncated: false }) }));
vi.mock("@/lib/trades-data", () => {
  // Every list query (live, locked, drafts) resolves empty; only today's closed trades come back.
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "is", "order", "limit"]) chain[method] = () => chain;
  // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
  chain.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
  return {
    // All Accounts list reads are split per account (the real helpers' contract; every read resolves empty here).
    ACCOUNT_READ_CONCURRENCY: 4,
    accountScopes: (scope: { mode: string }, accounts: readonly { id: string }[]) =>
      scope.mode === "account" || accounts.length === 0 ? [scope] : accounts.map(account => ({ mode: "account", accountId: account.id })),
    mapLimited: <T, R>(items: readonly T[], _limit: number, task: (item: T) => Promise<R>) => Promise.all(items.map(task)),
    newestCreatedFirst: () => 0,
    openLedgerRows: async () => [],
    ledgerSelect: () => chain,
    parseLedger: (data: unknown) => data,
    inBatches: <T,>(values: readonly T[]) => (values.length ? [[...values]] : []),
    decorateTrades: async (_deps: unknown, trades: { id: string }[]) => trades.map(trade => ({ id: trade.id, trade, state: {} })),
  };
});
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn(), loadAccountWorkspace: vi.fn(), loadDailyUsage: m.loadDailyUsage }));

import type { AccountContext, ContextAccount, Db } from "@/lib/account-context";
import { loadToday } from "@/lib/today-data";
import type { AccountWorkspace } from "@/lib/workspace";

const NOW = "2026-10-23T14:00:00Z"; // Fri Oct 23, 09:00 UTC−5
const DAY = "2026-10-23";
const USER = "10000000-0000-4000-8000-000000000001";
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const DEMO = "20000000-0000-4000-8000-000000000003";
const OLD = "20000000-0000-4000-8000-000000000004";
/** One account's Today also reads its plan · notes (`daily_contexts`): none here. */
function emptyQuery(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) chain[method] = () => chain;
  // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
  chain.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
  return chain;
}
const db = { from: () => emptyQuery() } as unknown as Db;

function account(id: string, name: string, currency: string, status: "ACTIVE" | "ARCHIVED"): ContextAccount {
  return { id, name, currency, type: "EVALUATION", platform: "MT5", broker: null, status, startingBalance: "100000", createdAt: "2026-09-01T10:00:00Z", profile: "PROFILE" };
}
const ACCOUNTS = [
  account(FTMO, "FTMO 100K", "USD", "ACTIVE"),
  account(PERSONAL, "Personal 12K", "EUR", "ARCHIVED"),
  account(DEMO, "Demo 100K", "USD", "ARCHIVED"),
  account(OLD, "Old 10K", "USD", "ARCHIVED"),
];

function context(selected: "all" | string): AccountContext {
  const pick = ACCOUNTS.find(item => item.id === selected);
  return {
    accounts: ACCOUNTS, active: ACCOUNTS.filter(item => item.status === "ACTIVE"), archived: ACCOUNTS.filter(item => item.status === "ARCHIVED"),
    selected: pick ? { mode: "account", account: pick } : { mode: "all" }, notice: null, noticeText: null,
    scopeAccountIds: pick ? [pick.id] : ACCOUNTS.map(item => item.id), formDefaultAccountId: null,
  } as AccountContext;
}

function usage(realizedLoss: string, externalLoss = "0") {
  return {
    day: DAY, plannedSlots: 0, unplannedTrades: 0, plannedRisk: "0", unplannedRisk: "0", openExposure: "0", riskUnknownTrades: 0,
    realizedLoss, externalLoss, legacyReportedLoss: null, lossTotal: String(Number(realizedLoss) + Number(externalLoss)),
  };
}

/** The status row of an active account: only its account and daily usage are read for the losses. */
function workspace(owner: ContextAccount, realizedLoss: string, externalLoss = "0"): AccountWorkspace {
  return { account: owner, usage: usage(realizedLoss, externalLoss) } as unknown as AccountWorkspace;
}

function closed(n: number, accountId: string, currency: string, netPnl: string, exitedAt = "2026-10-23T13:00:00.000Z") {
  return {
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, account_id: accountId, currency, lifecycle: "CLOSED", outcome: Number(netPnl) < 0 ? "LOSS" : "WIN",
    net_pnl: netPnl, fees: null, realized_r: null, exited_at: exitedAt, created_at: "2026-10-23T12:00:00.000Z", entered_at: null, entry_recorded_at: null, plan_id: null,
  };
}

beforeEach(() => {
  m.loadDailyUsage.mockReset();
  m.loadDailyUsage.mockImplementation(async (_db: Db, accountId: string) => m.usage.get(accountId));
  m.usage = new Map([
    // Personal closed a −€26.825 trade after archiving; Demo lost $295 on a trade and had $85 entered as external.
    [PERSONAL, usage("26.825")],
    [DEMO, usage("295", "85")],
    [OLD, usage("0", "40")],
  ]);
});

describe("Today's losses over the accounts of today's result", () => {
  it("adds, in All Accounts, the daily usage of every archived account that closed a trade today, external losses included", async () => {
    m.closed = [
      closed(1, FTMO, "USD", "120"),
      closed(2, PERSONAL, "EUR", "-26.825"),
      closed(3, DEMO, "USD", "-295"),
      closed(4, DEMO, "USD", "10"),
    ];
    const data = await loadToday({ db, userId: USER, context: context("all"), workspaces: [workspace(ACCOUNTS[0], "10.5", "4.25")], now: NOW });
    // One usage read per archived account with a trade closed today; none for the row's account or an untouched archive.
    expect(m.loadDailyUsage.mock.calls.map(([, id]) => id).sort()).toEqual([PERSONAL, DEMO].sort());
    expect(data.losses).toEqual([
      { currency: "EUR", realized: "26.825", external: "0", legacyReported: null, total: "26.825" },
      { currency: "USD", realized: "305.5", external: "89.25", legacyReported: null, total: "394.75" },
    ]);
    expect(data.result).toMatchObject({ closed: 4 });
    // The status rows stay the active accounts.
    expect(data.accounts.map(entry => entry.account.id)).toEqual([FTMO]);
  });

  it("reads no other usage when no archived account closed a trade today, or for one account's Today", async () => {
    m.closed = [closed(1, FTMO, "USD", "-50"), closed(2, DEMO, "USD", "-295", "2026-10-22T13:00:00.000Z")];
    const all = await loadToday({ db, userId: USER, context: context("all"), workspaces: [workspace(ACCOUNTS[0], "50")], now: NOW });
    // A row from another strategy day is not in today's result, so its account is not added either.
    expect(m.loadDailyUsage).not.toHaveBeenCalled();
    expect(all.losses).toEqual([{ currency: "USD", realized: "50", external: "0", legacyReported: null, total: "50" }]);

    m.closed = [closed(2, PERSONAL, "EUR", "-26.825")];
    const one = await loadToday({ db, userId: USER, context: context(PERSONAL), workspaces: [workspace(ACCOUNTS[1], "26.825")], now: NOW });
    expect(m.loadDailyUsage).not.toHaveBeenCalled();
    expect(one.losses).toEqual([{ currency: "EUR", realized: "26.825", external: "0", legacyReported: null, total: "26.825" }]);
  });
});
