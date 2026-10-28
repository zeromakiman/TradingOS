import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Manage → Connection (docs/V2_ARCHITECTURE.md §8.6, §14.9): the executions of one account come from
// src/lib/sync-service.ts with the trader's RLS session (one read per list, no per-execution reads), and the panel says
// when more linked executions exist than it lists. The RLS of these reads is proven on PGlite in
// tests/v2-connections-database.test.ts ("execution lists of Manage → Connection").

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };
const m = vi.hoisted(() => ({ db: null as unknown, noop: (() => undefined) as (...args: unknown[]) => void }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: m.db, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: m.noop, replace: m.noop, refresh: m.noop, prefetch: m.noop, back: m.noop, forward: m.noop }),
  usePathname: () => "/accounts/20000000-0000-4000-8000-000000000001/manage",
}));
vi.mock("@/app/actions/connections", () => ({
  createMockConnection: vi.fn(), disconnectConnection: vi.fn(), runMockSync: vi.fn(), linkExecution: vi.fn(), unlinkExecution: vi.fn(),
}));
vi.mock("@/app/actions/accounts", () => ({
  createTradingAccount: vi.fn(), updateProfile: vi.fn(), archiveAccount: vi.fn(), restoreAccount: vi.fn(), createInstrument: vi.fn(), recordAccountValues: vi.fn(),
  confirmAccountValuesUnchanged: vi.fn(), addExternalLoss: vi.fn(), removeExternalLoss: vi.fn(), createRiskPolicyVersion: vi.fn(),
}));

import { type ConnectionDetails, LINKED_LIMIT, loadConnectionDetails } from "@/components/accounts/connection-data";
import { ManageView } from "@/components/accounts/manage-view";
import type { ContextAccount } from "@/lib/account-context";
import type { AccountManage } from "@/lib/accounts-data";
import { type ExternalExecution, platformOptions } from "@/lib/sync-service";

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "20000000-0000-4000-8000-000000000002";
const CONNECTION = "50000000-0000-4000-8000-000000000001";
const EURUSD = "60000000-0000-4000-8000-000000000001";
const id = (prefix: number, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Query { table: string; filters: string[]; limit: number | null }

/** In-memory PostgREST stand-in for the reads of connection-data (filters, orders, limits). */
function fakeClient(tables: Record<string, Row[]>) {
  const queries: Query[] = [];
  const compare = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const db = {
    from(table: string) {
      const query: Query = { table, filters: [], limit: null };
      queries.push(query);
      const predicates: ((row: Row) => boolean)[] = [];
      const orders: [string, boolean][] = [];
      let columns: string[] = [];
      const add = (text: string, predicate: (row: Row) => boolean) => {
        query.filters.push(text);
        predicates.push(predicate);
        return chain;
      };
      const chain = {
        select: (list: string) => { columns = list.split(",").map(column => column.replace(/::text$/, "")); return chain; },
        eq: (column: string, value: unknown) => add(`eq.${column}`, row => row[column] === value),
        in: (column: string, values: unknown[]) => add(`in.${column}`, row => values.includes(row[column])),
        is: (column: string, value: null) => add(`is.${column}`, row => row[column] === value),
        not: (column: string, _operator: string, value: null) => add(`not.is.${column}`, row => row[column] !== value),
        gt: (column: string, value: unknown) => add(`gt.${column}`, row => compare(row[column], value) > 0),
        order: (column: string, options: { ascending?: boolean } = {}) => { orders.push([column, options.ascending !== false]); return chain; },
        limit: (count: number) => { query.limit = count; return chain; },
        // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
        then: (resolve: (value: Result) => unknown) => {
          let rows = (tables[table] ?? []).filter(row => predicates.every(predicate => predicate(row)));
          for (const [column, ascending] of [...orders].reverse()) rows = [...rows].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
          if (query.limit !== null) rows = rows.slice(0, query.limit);
          return Promise.resolve({ data: rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]))), error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
  return { db, queries };
}

/** A stored execution of the account, entered `n` minutes after 07:00 UTC on Sep 15 (later n = newer). */
function executionRow(n: number, changes: Row = {}): Row {
  const entered = new Date(Date.UTC(2026, 8, 15, 7, n)).toISOString().replace(".000Z", "+00:00");
  return {
    id: id(7, n), account_id: ACCOUNT, connection_id: CONNECTION, provider: "MOCK", connection_label: "Mock platform", external_id: `MOCK-${n}`, symbol: "EURUSD",
    direction: "LONG", volume: "0.25", entry_price: "1.10012", entered_at: entered, exit_price: null, exited_at: null, commission: null, swap: null, realized_pnl: null,
    currency: "USD", payload_hash: "a".repeat(64), received_at: "2026-09-16T08:00:00+00:00", close_received_at: null, linked_trade_id: null, link_method: null,
    linked_at: null, warning_count: 0, last_warning_message: null, last_warning_at: null, ...changes,
  };
}
const linkedRow = (n: number, method = "USER", changes: Row = {}) =>
  executionRow(n, { linked_trade_id: id(3, n), link_method: method, linked_at: "2026-09-16T09:00:00+00:00", ...changes });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadConnectionDetails", () => {
  it("reads the linked executions through sync-service in one query, newest first, and says when more exist than are listed", async () => {
    const linked = Array.from({ length: LINKED_LIMIT + 2 }, (_, index) => linkedRow(index + 1, index % 3 === 0 ? "IMPORT_CREATED" : index % 3 === 1 ? "AUTO_MATCH" : "USER"));
    const { db, queries } = fakeClient({
      external_execution_status: [...linked, linkedRow(200, "USER", { account_id: OTHER_ACCOUNT }), executionRow(300)],
      trade_ledger: [], instrument_versions: [],
    });
    m.db = db;
    const details = await loadConnectionDetails(ACCOUNT);
    expect(details.linked).toHaveLength(LINKED_LIMIT);
    expect(details.moreLinked).toBe(true);
    expect(details.linked[0].externalId).toBe(`MOCK-${LINKED_LIMIT + 2}`);
    expect(details.linked.every(execution => execution.accountId === ACCOUNT && execution.linkedTradeId !== null)).toBe(true);
    expect(new Set(details.linked.map(execution => execution.linkMethod))).toEqual(new Set(["IMPORT_CREATED", "AUTO_MATCH", "USER"]));
    const executionReads = queries.filter(query => query.table === "external_execution_status");
    // One page per list (unmatched and linked), each one row longer than shown; never one read per execution.
    expect(executionReads.map(query => [query.filters, query.limit])).toEqual([
      [["is.linked_trade_id", "eq.account_id"], 26],
      [["not.is.linked_trade_id", "eq.account_id"], LINKED_LIMIT + 1],
    ]);
    expect(details.unmatched.map(view => view.execution.externalId)).toEqual(["MOCK-300"]);
    expect(details.moreUnmatched).toBe(false);
  });

  it("lists unmatched executions with the planned trades they may belong to, and no more-linked note when everything is listed", async () => {
    const { db } = fakeClient({
      external_execution_status: [executionRow(5, { entered_at: "2026-09-15T07:05:00+00:00" }), linkedRow(1)],
      trade_ledger: [{
        id: id(3, 9), account_id: ACCOUNT, origin: "PLANNED", lifecycle: "LOCKED", symbol: "EURUSD", direction: "LONG", locked_at: "2026-09-15T07:00:00+00:00",
        planned_entry: "1.1", planned_stop: "1.098", instrument_version_id: EURUSD,
      }],
      instrument_versions: [{ id: EURUSD, tick_size: "0.00001" }],
    });
    m.db = db;
    const details = await loadConnectionDetails(ACCOUNT);
    expect(details.unmatched.map(view => [view.execution.externalId, view.candidates.map(candidate => [candidate.tradeId, candidate.suggested])]))
      .toEqual([["MOCK-5", [[id(3, 9), true]]]]);
    expect(details.linked.map(execution => execution.externalId)).toEqual(["MOCK-1"]);
    expect(details.moreLinked).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const FTMO: ContextAccount = {
  id: ACCOUNT, name: "FTMO 100K", currency: "USD", type: "EVALUATION", platform: "MANUAL", broker: null, status: "ACTIVE", startingBalance: "100000",
  createdAt: "2026-07-23T12:00:00Z", profile: "PROFILE",
};
const MANAGE: AccountManage = {
  account: FTMO, now: "2026-10-23T19:00:00Z", day: "2026-10-23", startingBalance: "100000", profileHistory: [],
  values: { latest: null, confirmedToday: false, history: [] }, externalLosses: { today: [], recent: [], todayTotal: "0" }, riskPlans: [], activeRiskPlan: null,
  strategy: null, instruments: [], connection: { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null }, platformOptions: platformOptions({}), archived: false,
};

function execution(n: number, changes: Partial<ExternalExecution> = {}): ExternalExecution {
  return {
    id: id(7, n), accountId: ACCOUNT, connectionId: CONNECTION, provider: "MOCK", connectionLabel: "Mock platform", externalId: `MOCK-${n}`, symbol: "EURUSD",
    direction: "LONG", volume: "0.5", entryPrice: "1.08512", enteredAt: "2026-10-22T13:00:00Z", exitPrice: null, exitedAt: null, commission: null, swap: null,
    realizedPnl: null, currency: "USD", payloadHash: "a".repeat(64), receivedAt: "2026-10-22T13:01:00Z", closeReceivedAt: null, linkedTradeId: null, linkMethod: null,
    linkedAt: null, warningCount: 0, lastWarningMessage: null, lastWarningAt: null, ...changes,
  };
}

function panel(details: ConnectionDetails): string {
  const html = renderToStaticMarkup(createElement(ManageView, { manage: MANAGE, display: { mode: "strategy" }, tab: "connection", connection: details, instrumentDraft: null }));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

describe("Manage → Connection panel", () => {
  const linked = [
    execution(1, { linkedTradeId: id(3, 1), linkMethod: "AUTO_MATCH" }),
    execution(2, { linkedTradeId: id(3, 2), linkMethod: "USER" }),
    execution(3, { linkedTradeId: id(3, 3), linkMethod: "IMPORT_CREATED" }),
  ];

  it("offers Unlink for automatic and trader links only; trades imported from a position stay linked", () => {
    const text = panel({ unmatched: [], moreUnmatched: false, linked, moreLinked: false });
    expect(text.split("Unlink").length - 1).toBe(2);
    expect(text).toContain("Imported trade");
    expect(text).not.toContain("most recent linked executions");
  });

  it("says when only the most recent linked executions are listed", () => {
    expect(panel({ unmatched: [], moreUnmatched: false, linked, moreLinked: true })).toContain("Showing the 3 most recent linked executions.");
  });
});
