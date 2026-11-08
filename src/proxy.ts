import { type CookieOptions, createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { authCookieOptions } from "./lib/cookie-security";
import { publicConfig } from "./lib/supabase/config";

/**
 * Proxy (docs/V2_ARCHITECTURE.md §1.3, §9.2) for every request except static assets and the app icons:
 * - refreshes the Supabase session cookies (`getClaims`; HttpOnly, Secure on HTTPS: authCookieOptions) and marks every
 *   response private and uncacheable;
 * - redirects signed-out page requests to /login, except the public pages; route handlers (`/api/*`, `/edge/export`)
 *   keep their own JSON/CSV 401 answers and are never redirected to HTML;
 * - applies the account context of `?account=all|<id>` on signed-in page requests. The value is mirrored into this
 *   request's cookies, so every server component renders the page for the context its URL names. Only a page load the
 *   person made (a document navigation that is not a speculative prefetch or prerender) also STORES it in the
 *   `tos_account` cookie: an id is first checked with the user's session (it must be one of their active accounts), and
 *   an unavailable id stores All Accounts and flags this one request (ACCOUNT_UNAVAILABLE notice, shown once). A value
 *   mirrored without being stored travels with the value that stays stored (ACCOUNT_STORED_HEADER), so the page still
 *   knows whether the stored context itself is unavailable (the shell then stores All Accounts once).
 *
 * The Next.js router's own fetches (client-side navigations, refreshes and `<Link>` prefetches) are never stored here:
 * Next.js removes its `RSC`, `Next-Router-Prefetch` and `Next-Router-State-Tree` headers before the proxy runs, so a
 * hover or viewport prefetch cannot be told apart from a navigation at this point. The shell stores the context of a
 * client-side navigation instead, after it happened (src/components/shell/context-sync.ts), with the same checks as the
 * account selector (setAccountContext). A prefetch can therefore never switch the context.
 */

const PUBLIC_PAGES = new Set(["/login", "/forgot-password", "/update-password"]);
/** Same names and attributes as src/lib/account-context.ts (the proxy runs without server-only modules). */
const ACCOUNT_COOKIE = "tos_account";
const ACCOUNT_NOTICE_HEADER = "x-tos-account-notice";
const ACCOUNT_STORED_HEADER = "x-tos-account-stored";
const ACCOUNT_UNAVAILABLE = "ACCOUNT_UNAVAILABLE";
const ALL_ACCOUNTS = "all";
const CONTEXT_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Route handlers answer signed-out requests themselves (JSON or CSV 401). */
function isRouteHandler(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || path === "/edge/export";
}

function accountValue(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return value === ALL_ACCOUNTS || UUID.test(value) ? value : null;
}

/** Speculative loads by the browser (`<link rel=prefetch>`, speculation rules, prerendering) and other user agents. */
export function isSpeculativeRequest(headers: Pick<Headers, "get">): boolean {
  const purpose = ["sec-purpose", "purpose", "x-purpose", "x-moz"].map(name => headers.get(name) ?? "").join(" ").toLowerCase();
  return /\b(prefetch|prerender|preview)\b/.test(purpose);
}

/**
 * A page load the person made: a top-level document navigation (`Sec-Fetch-Mode: navigate`), or, from a browser
 * without Fetch Metadata, a request for HTML. The router's fetches send `Sec-Fetch-Mode: cors` and accept any type.
 */
export function isDocumentNavigation(headers: Pick<Headers, "get">): boolean {
  if (isSpeculativeRequest(headers)) return false;
  const mode = headers.get("sec-fetch-mode");
  if (mode !== null) return mode.trim().toLowerCase() === "navigate";
  return (headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

type AccountCheck = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
type ProxyClient = ReturnType<typeof createServerClient>;

/** One of the user's accounts whose latest profile is active (no profile means active), read through RLS. */
async function checkAccount(db: ProxyClient, accountId: string): Promise<AccountCheck> {
  try {
    const [account, profile] = await Promise.all([
      db.from("accounts").select("id").eq("id", accountId).maybeSingle(),
      db.from("account_profiles").select("status").eq("account_id", accountId).order("id", { ascending: false }).limit(1),
    ]);
    if (account.error || profile.error) return "UNKNOWN";
    if (!account.data) return "UNAVAILABLE";
    const latest: unknown = Array.isArray(profile.data) ? profile.data[0] : undefined;
    const status = latest && typeof latest === "object" && "status" in latest ? latest.status : "ACTIVE";
    return status === "ACTIVE" ? "AVAILABLE" : "UNAVAILABLE";
  } catch {
    return "UNKNOWN";
  }
}

export async function proxy(request: NextRequest) {
  // The context headers are only ever set below; client-supplied ones are dropped.
  request.headers.delete(ACCOUNT_NOTICE_HEADER);
  request.headers.delete(ACCOUNT_STORED_HEADER);
  let response = NextResponse.next({ request });
  const cacheHeaders = new Headers({ "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0", Expires: "0", Pragma: "no-cache" });
  const path = request.nextUrl.pathname;
  const isPrivate = !PUBLIC_PAGES.has(path) && !isRouteHandler(path);
  const config = publicConfig();
  if (!config) {
    return isPrivate ? NextResponse.redirect(new URL("/login", request.url)) : response;
  }
  const hadSession = request.cookies.getAll().some(c => c.name.startsWith(config.cookiePrefix));
  const changed = new Map<string, { name: string; value: string; options: CookieOptions }>();
  /** Forwards the (possibly changed) request and keeps every refreshed session cookie on the response. */
  const forward = () => {
    response = NextResponse.next({ request });
    for (const { name, value, options } of changed.values()) response.cookies.set(name, value, options);
  };
  const supabase = createServerClient(config.url, config.key, {
    // Refreshed session cookies get the attributes of the server actions' client (src/lib/supabase/server.ts).
    cookieOptions: authCookieOptions(request.nextUrl.protocol === "https:"),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        for (const cookie of values) {
          request.cookies.set(cookie.name, cookie.value);
          changed.set(cookie.name, cookie);
        }
        forward();
        for (const [key, value] of Object.entries(headers)) cacheHeaders.set(key, value);
      },
    },
  });
  const { data, error } = await supabase.auth.getClaims();
  const unavailable = error && (error.status === 429 || (error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError");
  if (isPrivate && !unavailable && (error || !data?.claims)) {
    const denied = NextResponse.redirect(new URL(hadSession ? "/login?reason=session" : "/login", request.url));
    for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
    cacheHeaders.forEach((value, key) => {
      denied.headers.set(key, value);
    });
    return denied;
  }

  // §9.2: `?account=` on a signed-in page request renders that context; a page load also stores it.
  const requested = isPrivate && data?.claims && (request.method === "GET" || request.method === "HEAD")
    ? accountValue(request.nextUrl.searchParams.get("account"))
    : null;
  const storedValue = request.cookies.get(ACCOUNT_COOKIE)?.value;
  if (requested !== null && requested !== storedValue) {
    if (isDocumentNavigation(request.headers)) {
      const check = requested === ALL_ACCOUNTS ? "AVAILABLE" : await checkAccount(supabase, requested);
      const stored = check === "UNAVAILABLE" ? ALL_ACCOUNTS : requested;
      request.cookies.set(ACCOUNT_COOKIE, stored);
      if (check === "UNAVAILABLE") request.headers.set(ACCOUNT_NOTICE_HEADER, ACCOUNT_UNAVAILABLE);
      forward();
      response.cookies.set(ACCOUNT_COOKIE, stored, {
        httpOnly: true, sameSite: "lax", path: "/", maxAge: CONTEXT_COOKIE_MAX_AGE, secure: request.nextUrl.protocol === "https:",
      });
    } else {
      // This request only: the page resolves the value with the user's session (an unavailable id renders All Accounts
      // with the notice), and nothing is stored, so neither a prefetch nor a refresh of an old URL switches the context.
      // The page also learns what stays stored ("all", an id, or "none" for nothing usable), which the request's cookie
      // no longer tells it.
      request.headers.set(ACCOUNT_STORED_HEADER, accountValue(storedValue ?? null) ?? "none");
      request.cookies.set(ACCOUNT_COOKIE, requested);
      forward();
    }
  }
  cacheHeaders.forEach((value, key) => {
    response.headers.set(key, value);
  });
  return response;
}

/**
 * Every path except build assets, image optimization and the root files (§1.3): the favicon, the app icons
 * (src/app/icon.svg, src/app/apple-icon.png) and robots.txt, which signed-out pages such as /login load too.
 */
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|robots.txt).*)"] };
