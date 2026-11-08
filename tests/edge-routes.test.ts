import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /edge/export (docs/V2_ARCHITECTURE.md §1.2, §1.3): authentication, refusals and failure containment of EDGE's
// closed-trades CSV, plus the proxy's handling of EDGE. File contents and EDGE parity: tests/v2-data-export.test.ts.

type Result = { data: unknown; error: { message: string } | null };
const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  claims: vi.fn(),
  tables: [] as string[],
  result: { data: [], error: null } as { data: unknown; error: { message: string } | null },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
/** Every query of the session client answers `m.result`; the tables read are recorded in order. */
vi.mock("@/lib/supabase/server", () => {
  const query = (single: boolean): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "contains", "order", "limit"]) chain[name] = () => chain;
    chain.maybeSingle = () => query(true);
    // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
    chain.then = (resolve: (value: Result) => unknown) =>
      Promise.resolve(single && Array.isArray(m.result.data) ? { data: m.result.data[0] ?? null, error: m.result.error } : m.result).then(resolve);
    return chain;
  };
  const db = { auth: { getUser: m.getUser }, from: (table: string) => { m.tables.push(table); return query(false); } };
  return { supabaseServer: async () => db, requireUser: async () => ({ db, user: { id: "owner" } }) };
});
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: m.claims } }) }));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: () => ({ url: "https://example.supabase.co", key: "public", cookiePrefix: "sb-test" }) }));

import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { GET } from "@/app/edge/export/route";
import { config, proxy } from "@/proxy";

// The proxy matcher is a catch-all (docs/V2_ARCHITECTURE.md §1.3): coverage is checked with Next's own matcher compiler.
const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info.js") as {
  getMiddlewareMatchers(matcher: unknown, nextConfig: object): { regexp: string }[];
};
const proxyCovers = (path: string) => getMiddlewareMatchers(config.matcher, {}).some(matcher => new RegExp(matcher.regexp).test(path));
const OWNER = "10000000-0000-4000-8000-000000000001";
const csv = (query = "") => GET(new Request(`http://localhost/edge/export${query}`));

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  m.tables = [];
  m.result = { data: [], error: null };
  log = vi.spyOn(console, "error").mockImplementation(() => {});
  m.getUser.mockResolvedValue({ data: { user: { id: OWNER } }, error: null });
  m.claims.mockResolvedValue({ data: null, error: null });
});
afterEach(() => log.mockRestore());

describe("EDGE CSV: authentication and failure boundaries", () => {
  it("denies anonymous CSV with a JSON 401 before reading any trading data", async () => {
    m.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await csv("?account=all");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(m.tables).toEqual([]);
  });

  it("distinguishes an authentication outage from sign-out without leaking credentials", async () => {
    m.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 503, message: "SECRET credentials" } });
    const response = await csv();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("temporarily unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
    expect(m.tables).toEqual([]);
  });

  it.each([
    ["an impossible calendar date", "?from=2026-02-30", "from"],
    ["an unknown account value", "?account=selected", "account"],
    ["an unknown model", "?account=all&model=SCALP", "model"],
    ["an unknown V1 period", "?period=forever", "period"],
    ["a V1 risk that is not a risk-plan version", "?risk=0.5", "risk"],
    ["a result EDGE never counts (open trades)", "?account=all&result=open", "result"],
    ["a V1 range that excludes every day of the link's own range", "?range=last-month&period=month", "period"],
  ])("refuses %s by name instead of ignoring it, before reading anything", async (_label, query, name) => {
    const response = await csv(query);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(`Some filters in this export link couldn't be read: ${name}.`);
    expect(m.tables).toEqual([]);
  });

  it("keeps the V1 message for an inverted date range", async () => {
    const response = await csv("?from=2026-10-09&to=2026-10-01");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Start date must be on or before end date.");
    expect(m.tables).toEqual([]);
  });

  it("returns a private, header-only CSV attachment when no closed trade matches", async () => {
    const response = await csv("?account=all");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="trading-os-closed-trades-all-accounts-\d{4}-\d{2}-\d{2}\.csv"$/);
    // UTF-8 with a byte-order mark (Response.text() would drop it, so the bytes are read), then the V1 header alone.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(text.split("\r\n")).toHaveLength(1);
    expect(text.startsWith("instrument,entry_model,direction,status,")).toBe(true);
    // All Accounts reads the ledger one account at a time (`loadLedgerRows`), so the read lists the accounts first.
    expect(m.tables).toEqual(["accounts", "account_profiles", "accounts", "trade_ledger"]);
  });

  it("refuses an account that is not one of the user's (404) and never falls back to another account", async () => {
    const response = await csv(`?account=${OWNER.replace("1000", "2000")}`);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("That trading account isn't available.");
    expect(m.tables).not.toContain("trade_ledger");
  });

  it("contains a failed query: a generic 500, one fixed operational event, no database text", async () => {
    m.result = { data: null, error: { message: "SECRET token stack" } };
    const response = await csv("?account=all");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|token|stack/);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "request_failed", status: 500 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });
});

describe("EDGE behind the proxy", () => {
  it("protects the EDGE page before streaming and refreshes its session", async () => {
    expect(proxyCovers("/edge")).toBe(true);
    const response = await proxy(new NextRequest("http://localhost/edge"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps authenticated EDGE pages private", async () => {
    m.claims.mockResolvedValue({ data: { claims: { sub: OWNER } }, error: null });
    const response = await proxy(new NextRequest("http://localhost/edge"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
  });

  it("leaves a signed-out CSV request to the route (JSON 401) instead of redirecting it to HTML", async () => {
    expect(proxyCovers("/edge/export")).toBe(true);
    const response = await proxy(new NextRequest("http://localhost/edge/export?account=all"));
    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
