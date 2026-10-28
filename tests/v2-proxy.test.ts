import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Proxy (docs/V2_ARCHITECTURE.md §1.3, §9.2): a catch-all matcher covers every page and route handler (fixing the V1
// gap where /edge/weekly|recent|monthly had no session refresh); signed-out page requests go to /login except the
// public pages; route handlers keep their JSON/CSV 401; `?account=` is mirrored into the request, and only a page load
// the person made (never a prefetch, a prerender or one of the router's own fetches) validates and stores it.

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  claims: vi.fn(),
  cookies: null as null | { setAll: (values: { name: string; value: string; options: object }[], headers: Record<string, string>) => void },
  tables: {} as Record<string, Row[]>,
  failing: false,
  queries: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: () => ({ url: "https://example.supabase.co", key: "public", cookiePrefix: "sb-test" }) }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: unknown, _key: unknown, options: { cookies: typeof m.cookies }) => {
    m.cookies = options.cookies;
    return {
      auth: { getClaims: m.claims },
      from: (table: string) => {
        m.queries.push(table);
        const filters: [string, unknown][] = [];
        const chain = {
          select: () => chain,
          eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => chain,
          // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
          then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
            if (m.failing) return Promise.resolve({ data: null, error: { message: "network" } }).then(resolve);
            const rows = (m.tables[table] ?? []).filter(row => filters.every(([column, value]) => row[column] === value));
            return Promise.resolve({ data: table === "accounts" ? rows[0] ?? null : rows, error: null }).then(resolve);
          },
        };
        return chain;
      },
    };
  },
}));

import { NextRequest } from "next/server";
import { ACCOUNT_COOKIE, ACCOUNT_NOTICE_HEADER, CONTEXT_COOKIE_MAX_AGE } from "@/lib/account-context";
import { config, isDocumentNavigation, isSpeculativeRequest, proxy } from "@/proxy";

const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info.js") as {
  getMiddlewareMatchers(matcher: unknown, nextConfig: object): { regexp: string }[];
};
const matchers = getMiddlewareMatchers(config.matcher, {}).map(entry => new RegExp(entry.regexp));
const covers = (path: string) => matchers.some(matcher => matcher.test(path));

const USER = "10000000-0000-4000-8000-000000000001";
const ACTIVE = "20000000-0000-4000-8000-000000000001";
const ARCHIVED = "20000000-0000-4000-8000-000000000002";
const PUBLIC_PAGES = ["/login", "/forgot-password", "/update-password"];
const APP = join(process.cwd(), "src", "app");

/** Every file named `name` under src/app, as the URL path it serves (route groups removed, segments filled in). */
function routes(name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === name) found.push(relative(APP, dir));
    }
  };
  walk(APP);
  return found.map(dir => {
    const segments = dir.split(sep).filter(segment => segment && !/^\(.+\)$/.test(segment)).map(segment =>
      segment.startsWith("[...") || segment.startsWith("[[...") ? "a/b" : segment.startsWith("[") ? "30000000-0000-4000-8000-000000000001" : segment);
    return `/${segments.join("/")}`;
  });
}

const signedIn = () => m.claims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
const signedOut = () => m.claims.mockResolvedValue({ data: null, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  m.failing = false;
  m.queries.length = 0;
  m.tables = {
    accounts: [{ id: ACTIVE }, { id: ARCHIVED }],
    account_profiles: [{ account_id: ACTIVE, status: "ACTIVE" }, { account_id: ARCHIVED, status: "ARCHIVED" }],
  };
  signedIn();
});

describe("matcher coverage (§1.3)", () => {
  const pages = routes("page.tsx");
  const handlers = routes("route.ts");

  it("finds the app's pages and route handlers", () => {
    expect(pages).toEqual(expect.arrayContaining(["/today", "/journal", "/edge/weekly", "/edge/recent", "/edge/monthly", "/login"]));
    expect(handlers).toEqual(expect.arrayContaining(["/api/export", "/edge/export", `/api/trades/30000000-0000-4000-8000-000000000001/evidence`]));
  });

  it("runs on every page and every route handler, including their RSC requests", () => {
    for (const path of [...pages, ...handlers]) expect(covers(path), path).toBe(true);
    expect(covers("/edge/weekly.rsc")).toBe(true);
    expect(covers("/trades/abc/edit")).toBe(true);
  });

  it("skips build assets, image optimization and the root files only (favicon, app icons, robots.txt)", () => {
    for (const path of ["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico", "/icon.svg", "/apple-icon.png", "/robots.txt"]) expect(covers(path), path).toBe(false);
    // Signed-out pages (/login) load the icons, so a redirect to /login must never answer them; other paths stay covered.
    for (const path of ["/icons", "/today/icon.svg"]) expect(covers(path), path).toBe(true);
  });

  it("redirects every signed-out page to /login unless it is public", async () => {
    signedOut();
    for (const path of pages) {
      const response = await proxy(new NextRequest(`http://localhost${path}`));
      if (PUBLIC_PAGES.includes(path)) {
        expect(response.status, path).toBe(200);
        expect(response.headers.get("cache-control"), path).toContain("no-store");
      } else {
        expect(response.status, path).toBe(307);
        expect(response.headers.get("location"), path).toBe("http://localhost/login");
      }
    }
  });

  it("leaves signed-out route handlers to answer their own JSON or CSV 401", async () => {
    signedOut();
    for (const path of handlers) {
      const response = await proxy(new NextRequest(`http://localhost${path}`));
      expect(response.status, path).toBe(200);
      expect(response.headers.has("location"), path).toBe(false);
    }
  });
});

describe("account context from ?account= (§9.2)", () => {
  /** What a browser sends for a page load the person made (address bar, link, reload, new tab). */
  const DOCUMENT = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  /**
   * One of the Next.js router's own fetches (client-side navigation, refresh or `<Link>` prefetch) as the proxy sees it.
   * Next.js strips `RSC`, `Next-Router-Prefetch` and `Next-Router-State-Tree` before the proxy runs (they are kept here
   * to show that nothing depends on them), so a prefetch and a navigation look the same.
   */
  const ROUTER_FETCH = { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "*/*", rsc: "1", "next-router-prefetch": "1" };
  const request = (query: string, init: { cookie?: string; headers?: Record<string, string>; origin?: string; path?: string; method?: string } = {}) => {
    const headers = new Headers(init.headers ?? DOCUMENT);
    if (init.cookie) headers.set("cookie", init.cookie);
    return new NextRequest(`${init.origin ?? "http://localhost"}${init.path ?? "/journal"}${query}`, { headers, method: init.method });
  };
  const forwarded = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);
  const stored = (response: Response) => (response as unknown as { cookies: { get(name: string): Row | undefined } }).cookies.get(ACCOUNT_COOKIE);
  const storesNothing = (response: Response) => !response.headers.getSetCookie().some(header => header.startsWith("tos_account="));

  it("stores an active account of the user with the §9.2 attributes on a page load and mirrors it into this request", async () => {
    const response = await proxy(request(`?account=${ACTIVE.toUpperCase()}&model=OTE`));
    expect(response.status).toBe(200);
    expect(stored(response)).toMatchObject({ name: "tos_account", value: ACTIVE, httpOnly: true, sameSite: "lax", path: "/", maxAge: CONTEXT_COOKIE_MAX_AGE, secure: false });
    expect(forwarded(response, "cookie")).toContain(`tos_account=${ACTIVE}`);
    expect(forwarded(response, ACCOUNT_NOTICE_HEADER)).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(m.queries).toEqual(["accounts", "account_profiles"]);
  });

  it.each([
    ["an archived account", ARCHIVED],
    ["an unknown or foreign account", "20000000-0000-4000-8000-0000000000ff"],
  ])("stores All Accounts and flags this request once for %s", async (_label, id) => {
    const response = await proxy(request(`?account=${id}`));
    expect(stored(response)?.value).toBe("all");
    expect(forwarded(response, "cookie")).toContain("tos_account=all");
    expect(forwarded(response, ACCOUNT_NOTICE_HEADER)).toBe("ACCOUNT_UNAVAILABLE");
  });

  it("stores All Accounts without a lookup and secures the cookie over HTTPS", async () => {
    const response = await proxy(request("?account=all", { origin: "https://trading.example" }));
    expect(stored(response)).toMatchObject({ value: "all", secure: true });
    expect(m.queries).toEqual([]);
  });

  it("treats a request for HTML from a browser without Fetch Metadata as a page load", async () => {
    const response = await proxy(request(`?account=${ACTIVE}`, { headers: { accept: "text/html,*/*;q=0.8" } }));
    expect(stored(response)?.value).toBe(ACTIVE);
  });

  it.each([
    ["the router's fetch (client-side navigation, refresh or Link prefetch)", ROUTER_FETCH],
    ["a router fetch from a browser without Fetch Metadata", { accept: "*/*", rsc: "1" }],
    ["a browser prefetch (Sec-Purpose)", { ...DOCUMENT, "sec-purpose": "prefetch" }],
    ["a browser prerender (speculation rules)", { ...DOCUMENT, "sec-purpose": "prefetch;prerender" }],
    ["a legacy prefetch (Purpose)", { ...DOCUMENT, purpose: "prefetch" }],
    ["a Firefox link prefetch (X-Moz)", { accept: "text/html", "x-moz": "prefetch" }],
  ] as const)("renders but never stores the context for %s", async (_label, headers) => {
    const response = await proxy(request(`?account=${ACTIVE}`, { headers: { ...headers } }));
    expect(response.status).toBe(200);
    expect(storesNothing(response)).toBe(true);
    // This request renders the URL's context; the page resolves the value with the user's session.
    expect(forwarded(response, "cookie")).toContain(`tos_account=${ACTIVE}`);
    expect(forwarded(response, ACCOUNT_NOTICE_HEADER)).toBeNull();
    expect(m.queries).toEqual([]);
  });

  it("leaves an unavailable id of a router fetch to the page, which shows All Accounts with the notice", async () => {
    const response = await proxy(request(`?account=${ARCHIVED}`, { headers: ROUTER_FETCH, cookie: `tos_account=${ACTIVE}` }));
    expect(storesNothing(response)).toBe(true);
    expect(forwarded(response, "cookie")).toContain(`tos_account=${ARCHIVED}`);
    expect(m.queries).toEqual([]);
  });

  it.each([
    ["the value already stored", `?account=${ACTIVE}`, { cookie: `tos_account=${ACTIVE}` }],
    ["a malformed value", "?account=first", {}],
    ["a route handler", `?account=${ACTIVE}`, { path: "/api/export" }],
    ["the CSV export", `?account=${ACTIVE}`, { path: "/edge/export" }],
    ["a server action (POST)", `?account=${ACTIVE}`, { method: "POST" }],
  ] as const)("leaves the context unchanged for %s", async (_label, query, init) => {
    const response = await proxy(request(query, init));
    expect(storesNothing(response)).toBe(true);
    // Nothing is mirrored either (the stored value already is the one this request renders).
    if (!("cookie" in init)) expect(forwarded(response, "cookie") ?? "").not.toContain("tos_account=");
    expect(m.queries).toEqual([]);
  });

  it("never switches the context of a signed-out request", async () => {
    signedOut();
    const response = await proxy(request(`?account=${ACTIVE}`));
    expect(response.status).toBe(307);
    expect(storesNothing(response)).toBe(true);
  });

  it("keeps the requested id when the lookup fails (the page resolves it) and drops a client-supplied notice", async () => {
    m.failing = true;
    const response = await proxy(request(`?account=${ACTIVE}`, { headers: { ...DOCUMENT, [ACCOUNT_NOTICE_HEADER]: "ACCOUNT_UNAVAILABLE" } }));
    expect(stored(response)?.value).toBe(ACTIVE);
    expect(forwarded(response, ACCOUNT_NOTICE_HEADER)).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).not.toContain(ACCOUNT_NOTICE_HEADER);
  });

  it.each([
    ["stores", DOCUMENT, false],
    ["only renders", ROUTER_FETCH, true],
  ] as const)("keeps refreshed session cookies on the response that %s the context", async (_label, headers, renderOnly) => {
    m.claims.mockImplementation(async () => {
      m.cookies?.setAll([{ name: "sb-test-auth-token", value: "refreshed", options: { path: "/" } }], { "Cache-Control": "private, no-store" });
      return { data: { claims: { sub: USER } }, error: null };
    });
    const response = await proxy(request(`?account=${ACTIVE}`, { headers: { ...headers } }));
    const cookies = (response as unknown as { cookies: { get(name: string): Row | undefined } }).cookies;
    expect(cookies.get("sb-test-auth-token")?.value).toBe("refreshed");
    expect(forwarded(response, "cookie")).toContain(`tos_account=${ACTIVE}`);
    expect(storesNothing(response)).toBe(renderOnly);
  });
});

describe("request classification", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("recognises page loads by Fetch Metadata, and by an HTML Accept header without it", () => {
    expect(isDocumentNavigation(headers({ "sec-fetch-mode": "navigate" }))).toBe(true);
    expect(isDocumentNavigation(headers({ "sec-fetch-mode": "Navigate", accept: "*/*" }))).toBe(true);
    expect(isDocumentNavigation(headers({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isDocumentNavigation(headers({ "sec-fetch-mode": "cors", accept: "text/html" }))).toBe(false);
    expect(isDocumentNavigation(headers({ "sec-fetch-mode": "no-cors" }))).toBe(false);
    expect(isDocumentNavigation(headers({ accept: "*/*" }))).toBe(false);
    expect(isDocumentNavigation(headers({}))).toBe(false);
  });

  it("never counts a speculative load as a page load", () => {
    const speculative: Record<string, string>[] = [{ "sec-purpose": "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { purpose: "prefetch" }, { "x-purpose": "preview" }, { "x-moz": "prefetch" }];
    for (const entry of speculative) {
      expect(isSpeculativeRequest(headers(entry)), JSON.stringify(entry)).toBe(true);
      expect(isDocumentNavigation(headers({ "sec-fetch-mode": "navigate", accept: "text/html", ...entry })), JSON.stringify(entry)).toBe(false);
    }
    expect(isSpeculativeRequest(headers({ "sec-fetch-mode": "navigate" }))).toBe(false);
  });
});
