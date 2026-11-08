import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server actions' Supabase client (src/lib/supabase/server.ts) writes the browser's auth cookies: the session at
// sign-in, the PKCE code verifier at Forgot password and the session a recovery link's code starts. Driven through the
// real @supabase/ssr (only the network is stubbed), every one of them is HttpOnly (no browser code reads them: see the
// client-bundle scan in tests/v2-proxy.test.ts), SameSite=Lax on path /, and Secure when the request came over HTTPS
// (the browser's Origin, else X-Forwarded-Proto). The proxy's session refresh is covered in tests/v2-proxy.test.ts.
// The sign-ins then read the person's trading accounts on the NEW session to keep only their own context cookies
// (src/lib/account-context.ts keepOwnAccountContext, §9.2).

const NOW = new Date("2026-10-31T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const PREFIX = "sb-example-auth-token";
const USER = { id: "10000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "cookies@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" };
const OWN_ACCOUNT = "20000000-0000-4000-8000-000000000001";
const FOREIGN_ACCOUNT = "30000000-0000-4000-8000-000000000003";

const m = vi.hoisted(() => ({
  headers: new Headers(),
  jar: new Map<string, string>(),
  writes: [] as { name: string; value: string; options: Record<string, unknown> }[],
  deleted: [] as string[],
  /** The options each createServerClient call received. */
  clients: [] as { cookieOptions?: unknown; cookies: { setAll?: unknown } }[],
  requests: [] as { url: URL; authorization: string | null }[],
  /** Trading accounts of the signed-in user (what RLS lets the accounts read return). */
  owned: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/supabase/config", () => ({
  publicConfig: () => ({ url: "https://example.supabase.co", key: "sb_publishable_test", cookiePrefix: "sb-example-auth-token" }),
}));
vi.mock("next/headers", () => ({
  headers: async () => m.headers,
  cookies: async () => ({
    get: (name: string) => (m.jar.has(name) ? { name, value: m.jar.get(name) } : undefined),
    getAll: () => [...m.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      m.writes.push({ name, value, options });
      if (options.maxAge === 0) m.jar.delete(name);
      else m.jar.set(name, value);
    },
    delete: (name: string) => {
      m.deleted.push(name);
      m.jar.delete(name);
    },
  }),
}));
vi.mock("@supabase/ssr", async importOriginal => {
  const real = await importOriginal<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createServerClient: (url: string, key: string, options: Parameters<typeof real.createServerClient>[2]) => {
      m.clients.push(options);
      return real.createServerClient(url, key, options);
    },
  };
});

import { login } from "@/app/actions";
import { completePasswordRecovery, requestPasswordRecovery } from "@/app/password-actions";
import { supabaseServer } from "@/lib/supabase/server";

const segment = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
/** An access token of USER whose `amr` names how the session started. */
const accessToken = (method: string) =>
  [
    segment({ alg: "HS256", typ: "JWT" }),
    segment({ sub: USER.id, exp: NOW_SECONDS + 3600, iat: NOW_SECONDS, aud: "authenticated", role: "authenticated", session_id: `s-${method}`, aal: "aal1", amr: [{ method, timestamp: NOW_SECONDS - 30 }] }),
    "c2lnbmF0dXJl",
  ].join(".");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Auth cookie writes of the session (not the PKCE verifier) that set a value. */
const sessionWrites = () => m.writes.filter(write => write.name.startsWith(PREFIX) && !write.name.includes("code-verifier") && write.value !== "");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  m.headers = new Headers();
  m.jar.clear();
  m.writes.length = 0;
  m.deleted.length = 0;
  m.clients.length = 0;
  m.requests.length = 0;
  m.owned = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      m.requests.push({ url, authorization: headers.get("authorization") });
      const session = (method: string) =>
        Response.json({ access_token: accessToken(method), token_type: "bearer", expires_in: 3600, expires_at: NOW_SECONDS + 3600, refresh_token: `refresh-${method}`, user: USER });
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") return session("password");
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") return session("recovery");
      if (url.pathname === "/auth/v1/user") return Response.json(USER);
      if (url.pathname === "/auth/v1/recover") return Response.json({});
      if (url.pathname === "/rest/v1/accounts") {
        const wanted = /^in\.\((.*)\)$/.exec(url.searchParams.get("id") ?? "")?.[1]?.split(",") ?? [];
        return Response.json(wanted.filter(id => m.owned.includes(id)).map(id => ({ id })));
      }
      return Response.json({ message: "not stubbed" }, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("supabaseServer: the attributes of every auth cookie it writes", () => {
  it.each([
    [{ origin: "https://trading.example" }, true],
    [{ origin: "http://127.0.0.1:3000" }, false],
    [{ "x-forwarded-proto": "https" }, true],
    [{ "x-forwarded-proto": "https, http" }, true],
    [{ "x-forwarded-proto": "http" }, false],
    // The browser's Origin decides when the request has one.
    [{ origin: "http://127.0.0.1:3000", "x-forwarded-proto": "https" }, false],
    [{ origin: "null" }, false],
    [{}, false],
  ] as const)("a server action's client for %j: HttpOnly, SameSite=Lax, path /, Secure %s", async (requestHeaders, secure) => {
    m.headers = new Headers(requestHeaders as Record<string, string>);
    await supabaseServer(true);
    expect(m.clients.at(-1)?.cookieOptions).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure });
    expect(m.clients.at(-1)?.cookies.setAll).toBeTypeOf("function");
  });

  it("a page render's client cannot write cookies at all", async () => {
    m.headers = new Headers({ origin: "https://trading.example" });
    await supabaseServer();
    expect(m.clients.at(-1)?.cookies.setAll).toBeUndefined();
    expect(m.clients.at(-1)?.cookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it.each([
    ["https://trading.example", true],
    ["http://127.0.0.1:3000", false],
  ] as const)("a real password sign-in (Origin %s) writes the session cookie HttpOnly, Secure %s", async (origin, secure) => {
    m.headers = new Headers({ origin });
    const db = await supabaseServer(true);
    const { error } = await db.auth.signInWithPassword({ email: USER.email, password: "synthetic-password-1" });
    expect(error).toBeNull();
    expect(sessionWrites().length).toBeGreaterThan(0);
    for (const write of sessionWrites()) expect(write.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure });
  });

  it("Forgot password stores the PKCE code verifier HttpOnly and Secure over HTTPS", async () => {
    m.headers = new Headers({ origin: "https://trading.example" });
    await requestPasswordRecovery({}, form({ email: USER.email }));
    expect(m.requests.some(request => request.url.pathname === "/auth/v1/recover")).toBe(true);
    const verifier = m.writes.filter(write => write.name.startsWith(PREFIX) && write.name.includes("code-verifier"));
    expect(verifier.length).toBeGreaterThan(0);
    for (const write of verifier) expect(write.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
  });
});

describe("sign-ins through the real client: HttpOnly session, then the person's own context only", () => {
  it("login writes the session HttpOnly and Secure over HTTPS and reads the accounts on the new session", async () => {
    m.headers = new Headers({ origin: "https://trading.example" });
    m.jar.set("tos_account", FOREIGN_ACCOUNT);
    m.jar.set("tos_last_account", OWN_ACCOUNT);
    m.jar.set("tos_theme", "dark");
    m.owned = [OWN_ACCOUNT];
    await expect(login({}, form({ email: USER.email, password: "synthetic-password-1" }))).rejects.toThrow("REDIRECT:/today");
    expect(sessionWrites().length).toBeGreaterThan(0);
    for (const write of sessionWrites()) expect(write.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
    const read = m.requests.filter(request => request.url.pathname === "/rest/v1/accounts");
    expect(read).toHaveLength(1);
    // The signed-in person's token (not the publishable key), with an explicit owner filter.
    expect(read[0].authorization).toBe(`Bearer ${accessToken("password")}`);
    expect(read[0].url.searchParams.get("user_id")).toBe(`eq.${USER.id}`);
    expect(read[0].url.searchParams.get("id")).toBe(`in.(${FOREIGN_ACCOUNT},${OWN_ACCOUNT})`);
    expect(m.deleted).toEqual(["tos_account"]);
    expect(Object.fromEntries([...m.jar].filter(([name]) => name.startsWith("tos_")))).toEqual({ tos_last_account: OWN_ACCOUNT, tos_theme: "dark" });
  });

  it("a recovery link's code: the verifier from Forgot password starts the session, written HttpOnly, then the context is checked", async () => {
    m.headers = new Headers({ origin: "https://trading.example" });
    await requestPasswordRecovery({}, form({ email: USER.email }));
    m.writes.length = 0;
    m.jar.set("tos_account", OWN_ACCOUNT);
    m.jar.set("tos_last_account", FOREIGN_ACCOUNT);
    m.owned = [OWN_ACCOUNT];
    expect(await completePasswordRecovery({ kind: "code", code: "one-time-code" })).toEqual({ success: "Choose your new password." });
    expect(m.requests.some(request => request.url.pathname === "/auth/v1/token" && request.url.searchParams.get("grant_type") === "pkce")).toBe(true);
    expect(sessionWrites().length).toBeGreaterThan(0);
    for (const write of sessionWrites()) expect(write.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
    const read = m.requests.filter(request => request.url.pathname === "/rest/v1/accounts");
    expect(read).toHaveLength(1);
    expect(read[0].authorization).toBe(`Bearer ${accessToken("recovery")}`);
    expect(m.deleted).toEqual(["tos_last_account"]);
    expect(m.jar.get("tos_account")).toBe(OWN_ACCOUNT);
  });
});
