import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const scheduled = vi.hoisted(() => [] as (() => void)[]);
vi.mock("next/server", async importOriginal => ({ ...(await importOriginal<typeof import("next/server")>()), after: (task: () => void) => scheduled.push(task) }));

const { parseProxyStamp, perfPath, requestFetch, requestKind, summarizeCalls, supabaseEndpoint, PERF_PROXY_HEADER, PERF_ROUTE_HEADER } = await import("@/lib/perf");

const ID = "30000000-0000-4000-8000-000000000001";

describe("what a timing line may contain", () => {
  it("reduces Supabase URLs to their endpoint: no query, no ids", () => {
    expect(supabaseEndpoint(`https://x.supabase.co/rest/v1/trade_ledger?select=*&user_id=eq.${ID}`)).toBe("/rest/v1/trade_ledger");
    expect(supabaseEndpoint("https://x.supabase.co/rest/v1/rpc/daily_risk_usage")).toBe("/rest/v1/rpc/daily_risk_usage");
    expect(supabaseEndpoint("https://x.supabase.co/auth/v1/user")).toBe("/auth/v1/user");
    expect(supabaseEndpoint(`https://x.supabase.co/storage/v1/object/authenticated/evidence/${ID}/a.png`)).toBe("/storage/v1/object");
    expect(supabaseEndpoint("not a url")).toBe("/unknown");
  });

  it("replaces ids in routes", () => {
    expect(perfPath(`/trades/${ID}/edit`)).toBe("/trades/:id/edit");
  });

  it("accepts only a numeric proxy stamp", () => {
    expect(parseProxyStamp("12;0")).toEqual({ proxyMs: 12, proxyCalls: 0 });
    expect(parseProxyStamp("12;0;user@example.test")).toBeNull();
    expect(parseProxyStamp(null)).toBeNull();
  });

  it("tells a page load, a router fetch and a server action apart", () => {
    expect(requestKind(new Headers({ "sec-fetch-dest": "document" }))).toBe("document");
    expect(requestKind(new Headers({ "sec-fetch-dest": "empty" }))).toBe("rsc");
    expect(requestKind(new Headers({ "sec-fetch-dest": "empty", "next-action": "abc" }))).toBe("action");
    expect(requestKind(new Headers({ accept: "text/html" }))).toBe("document");
  });
});

describe("dependency levels", () => {
  const call = (path: string, start: number, end: number, ok = true) => ({ path, start, end, ok });

  it("counts a call that starts after another ended as one level deeper", () => {
    const summary = summarizeCalls([
      call("/auth/v1/user", 0, 90),
      call("/rest/v1/accounts", 95, 180),
      call("/rest/v1/rpc/trading_os_schema", 96, 170),
      call("/rest/v1/trade_ledger", 185, 400, false),
    ]);
    expect(summary).toMatchObject({ calls: 4, failed: 1, levels: 3, levelMs: [90, 85, 215], spanMs: 400, fastestMs: 74, authMs: 90, slowest: { path: "/rest/v1/trade_ledger", ms: 215 } });
  });

  it("puts overlapping calls on the same level", () => {
    expect(summarizeCalls([call("/a", 0, 100), call("/b", 50, 150)]).levels).toBe(1);
    expect(summarizeCalls([])).toMatchObject({ calls: 0, levels: 0, slowest: null });
  });
});

describe("request timing", () => {
  it("records only stamped page requests, once per request, and logs one line after the response", async () => {
    expect(requestFetch(new Headers())).toBeUndefined();
    const headers = new Headers({ [PERF_ROUTE_HEADER]: `/trades/${ID}`, [PERF_PROXY_HEADER]: "8;0", "sec-fetch-dest": "empty" });
    const fetch = requestFetch(headers);
    expect(fetch).toBeTypeOf("function");
    expect(requestFetch(headers)).toBe(fetch);
    expect(scheduled).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const timed = fetch as typeof globalThis.fetch;
    await timed(`https://x.supabase.co/rest/v1/trade_ledger?id=eq.${ID}`);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    scheduled[0]();
    vi.unstubAllGlobals();
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line).toMatchObject({ event: "tos-perf", route: "/trades/:id", kind: "rsc", cold: true, proxyMs: 8, proxyCalls: 0, calls: 1, levels: 1, slowest: { path: "/rest/v1/trade_ledger" } });
    expect(JSON.stringify(line)).not.toContain(ID);
    log.mockRestore();
  });
});
