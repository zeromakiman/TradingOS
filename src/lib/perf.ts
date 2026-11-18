import "server-only";
import { after } from "next/server";

/**
 * Production timing of page, RSC and server-action requests: one `tos-perf` JSON log line per request, read from the
 * Vercel runtime logs. It records how the request's Supabase calls line up (count, dependency levels, slowest call),
 * whether the function instance was cold, and where it ran. It never records a query string, a header value, a cookie,
 * a user, an account or a response body: endpoints are reduced to their table or function name (UUIDs become `:id`).
 *
 * The proxy stamps page requests with their route and its own auth time (PERF_ROUTE_HEADER, PERF_PROXY_HEADER); a
 * request without the stamp (a route handler) is not recorded. `TOS_PERF_LOG=off` turns the log lines off.
 */

export const PERF_ROUTE_HEADER = "x-tos-perf-route";
export const PERF_PROXY_HEADER = "x-tos-perf-proxy";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_LEVELS = 16;

/** A path as it may appear in a log line: no query, ids replaced, at most three segments for Supabase endpoints. */
export function perfPath(pathname: string, segments = 64): string {
  const parts = pathname.replace(UUID, ":id").split("/").filter(Boolean).slice(0, segments);
  return `/${parts.join("/")}`.slice(0, 96);
}

/** `/rest/v1/trade_ledger`, `/rest/v1/rpc/daily_risk_usage`, `/auth/v1/user`, `/storage/v1/object`. */
export function supabaseEndpoint(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "/unknown";
  }
  const depth = pathname.startsWith("/rest/v1/rpc/") ? 4 : 3;
  return perfPath(pathname, depth);
}

export interface PerfCall {
  path: string;
  start: number;
  end: number;
  ok: boolean;
}

export interface PerfSummary {
  calls: number;
  failed: number;
  /** Dependency depth: a call is one level deeper than the deepest call that ended before it started. */
  levels: number;
  /** Wall time of each level, from its first start to its last end. */
  levelMs: number[];
  /** First call start to last call end. */
  spanMs: number;
  /** The fastest call: an upper bound of the network round trip to Supabase. */
  fastestMs: number;
  /** `/auth/v1/*` calls, summed (the session check). */
  authMs: number;
  slowest: { path: string; ms: number } | null;
}

export function summarizeCalls(calls: readonly PerfCall[]): PerfSummary {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  const levelOf: number[] = [];
  const bounds: { start: number; end: number }[] = [];
  sorted.forEach((call, index) => {
    let level = 1;
    for (let before = 0; before < index; before++) {
      if (sorted[before].end <= call.start) level = Math.max(level, levelOf[before] + 1);
    }
    levelOf.push(level);
    const bound = bounds[level - 1];
    bounds[level - 1] = bound ? { start: Math.min(bound.start, call.start), end: Math.max(bound.end, call.end) } : { start: call.start, end: call.end };
  });
  const durations = sorted.map(call => call.end - call.start);
  const slowestIndex = durations.reduce((best, ms, index) => (ms > durations[best] ? index : best), 0);
  return {
    calls: sorted.length,
    failed: sorted.filter(call => !call.ok).length,
    levels: bounds.length,
    levelMs: bounds.slice(0, MAX_LEVELS).map(bound => Math.round(bound.end - bound.start)),
    spanMs: sorted.length ? Math.round(Math.max(...sorted.map(call => call.end)) - sorted[0].start) : 0,
    fastestMs: sorted.length ? Math.round(Math.min(...durations)) : 0,
    authMs: Math.round(sorted.filter(call => call.path.startsWith("/auth/")).reduce((sum, call) => sum + call.end - call.start, 0)),
    slowest: sorted.length ? { path: sorted[slowestIndex].path, ms: Math.round(durations[slowestIndex]) } : null,
  };
}

/** Proxy stamp: `<ms>;<calls>`, each a small integer. */
export function parseProxyStamp(value: string | null): { proxyMs: number; proxyCalls: number } | null {
  const match = /^(\d{1,6});(\d{1,3})$/.exec(value ?? "");
  return match ? { proxyMs: Number(match[1]), proxyCalls: Number(match[2]) } : null;
}

type RequestKind = "document" | "rsc" | "action";

/** A page load, a router fetch (client navigation or refresh) or a server action, from headers the browser sends. */
export function requestKind(headers: Pick<Headers, "get">): RequestKind {
  if (headers.get("next-action") !== null) return "action";
  const dest = headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document" ? "document" : "rsc";
  return (headers.get("accept") ?? "").includes("text/html") ? "document" : "rsc";
}

const BOOTED_AT = Date.now();
let requestsServed = 0;

class RequestTiming {
  readonly calls: PerfCall[] = [];
  readonly startedAt = performance.now();
  constructor(readonly route: string, readonly kind: RequestKind, readonly cold: boolean, readonly proxy: { proxyMs: number; proxyCalls: number } | null) {}

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: PerfCall = { path: supabaseEndpoint(url), start: performance.now(), end: 0, ok: false };
    this.calls.push(call);
    try {
      const response = await fetch(input, init);
      call.ok = response.ok;
      return response;
    } finally {
      call.end = performance.now();
    }
  };

  line(): Record<string, unknown> {
    const now = performance.now();
    // Calls still running when the response finished (an abandoned optional read) count until now.
    const settled = this.calls.map(call => (call.end ? call : { ...call, end: now }));
    const summary = summarizeCalls(settled.map(call => ({ ...call, start: call.start - this.startedAt, end: call.end - this.startedAt })));
    return {
      event: "tos-perf",
      route: this.route,
      kind: this.kind,
      cold: this.cold,
      region: process.env.VERCEL_REGION ?? "local",
      ...(this.proxy ?? {}),
      ...summary,
      firstCallMs: settled.length ? Math.round(Math.min(...settled.map(call => call.start)) - this.startedAt) : null,
      responseMs: Math.round(now - this.startedAt),
    };
  }
}

const timings = new WeakMap<object, RequestTiming>();

/**
 * The fetch of this request's Supabase clients, once per request (keyed by the request's `headers()` object, which
 * Next.js keeps for the whole request, server action and render alike); undefined when the request is not recorded.
 */
export function requestFetch(headers: Headers): typeof fetch | undefined {
  if (process.env.TOS_PERF_LOG === "off") return undefined;
  const existing = timings.get(headers);
  if (existing) return existing.fetch;
  const route = headers.get(PERF_ROUTE_HEADER);
  if (route === null) return undefined;
  const timing = new RequestTiming(perfPath(route), requestKind(headers), requestsServed === 0, parseProxyStamp(headers.get(PERF_PROXY_HEADER)));
  // A cold request: how long ago this instance loaded the module (the rest of the boot happened before it).
  const sinceBoot = timing.cold ? { sinceBootMs: Date.now() - BOOTED_AT } : {};
  try {
    after(() => {
      console.info(JSON.stringify({ ...timing.line(), ...sinceBoot }));
    });
  } catch {
    return undefined;
  }
  requestsServed++;
  timings.set(headers, timing);
  return timing.fetch;
}
