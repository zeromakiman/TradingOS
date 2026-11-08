import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Sign-in and sign-out (src/app/actions.ts). A wrong password is an ordinary answer, not an outage: only a network
// failure, a rate limit or a server error of the auth service writes an operational event, and every event is a fixed
// name with a status code (never the email, the password or the error text). The person sees the same copy either way.
// The module exports nothing else: the V1 actions it used to hold were endpoints no V2 page called.

const m = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  server: vi.fn(),
  config: vi.fn(),
  revalidate: vi.fn(),
  /** `db.from(table)`; its query resolves through `accounts` with the filters it was given. */
  from: vi.fn(),
  accounts: vi.fn(),
  cookies: [] as { name: string; value: string }[],
  deleted: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: m.server }));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: m.config }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => m.cookies, delete: (name: string) => m.deleted.push(name) }),
}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import * as actions from "@/app/actions";
import { login, logout } from "@/app/actions";

const EMAIL = "qa.login@example.test";
const PASSWORD = "synthetic-password-1";
const SIGN_IN_FAILED = "Sign-in failed. Check your email and password.";

function form(fields: Record<string, string> = { email: EMAIL, password: PASSWORD }): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

let log: MockInstance;
const events = () => log.mock.calls.map(call => JSON.parse(String(call[0])) as { event: string; status: number });

beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  m.server.mockResolvedValue({ auth: { signInWithPassword: m.signIn, signOut: m.signOut }, from: m.from });
  m.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = { table };
    const query = {
      select: (columns: string) => {
        filters.select = columns;
        return query;
      },
      eq: (column: string, value: unknown) => {
        filters[`eq.${column}`] = value;
        return query;
      },
      in: (column: string, values: unknown[]) => m.accounts({ ...filters, [`in.${column}`]: values }),
    };
    return query;
  });
  m.accounts.mockResolvedValue({ data: [], error: null });
  m.signIn.mockResolvedValue({ data: { user: { id: "u" }, session: {} }, error: null });
  m.signOut.mockResolvedValue({ error: null });
  m.config.mockReturnValue({ url: "http://127.0.0.1:54321", key: "sb_publishable_local", cookiePrefix: "sb-127-auth-token" });
  m.cookies = [];
  m.deleted = [];
});

afterEach(() => log.mockRestore());

describe("login", () => {
  it("signs in with the parsed credentials and opens Today without logging anything", async () => {
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.server).toHaveBeenCalledWith(true);
    expect(m.signIn).toHaveBeenCalledExactlyOnceWith({ email: EMAIL, password: PASSWORD });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong credentials", new AuthApiError("Invalid login credentials", 400, "invalid_credentials")],
    ["an unconfirmed email", new AuthApiError("Email not confirmed", 400, "email_not_confirmed")],
    ["a banned user", new AuthApiError("User is banned", 400, "user_banned")],
    ["a refused request", new AuthApiError("Request rejected", 422, "validation_failed")],
  ])("answers %s with the usual copy and writes no operational event", async (_label, error) => {
    m.signIn.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await login({}, form())).toEqual({ error: SIGN_IN_FAILED });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", new AuthRetryableFetchError("fetch failed", 0)],
    ["a gateway timeout", new AuthRetryableFetchError("Gateway Timeout", 504)],
    ["a server error", new AuthApiError("Internal Server Error", 500, "unexpected_failure")],
    ["an unavailable service", new AuthApiError("Service Unavailable", 503, undefined)],
    ["a rate limit", new AuthApiError("Too many requests", 429, "over_request_rate_limit")],
  ])("logs %s once as the auth service being unavailable, with the same copy", async (_label, error) => {
    m.signIn.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await login({}, form())).toEqual({ error: SIGN_IN_FAILED });
    expect(events()).toEqual([{ event: "auth_unavailable", status: 503 }]);
  });

  it("never writes the email, the password or the provider's message into a log line", async () => {
    m.signIn.mockResolvedValue({ data: { user: null, session: null }, error: new AuthApiError(`Upstream failed for ${EMAIL} ${PASSWORD}`, 502, undefined) });
    await login({}, form());
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(new RegExp(`${EMAIL}|${PASSWORD}|Upstream`));
  });

  it("validates the form before contacting the auth service", async () => {
    const invalid = await login({}, form({ email: "not-an-email", password: PASSWORD }));
    expect(invalid.error).toBeTruthy();
    expect(invalid.error).not.toBe(SIGN_IN_FAILED);
    expect(await login({}, form({ email: EMAIL, password: "" }))).toHaveProperty("error");
    expect(await login({}, form({ email: EMAIL, password: "x".repeat(257) }))).toHaveProperty("error");
    expect(m.server).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure with generic copy and a fixed event, never its message", async () => {
    m.server.mockRejectedValue(new Error("Supabase has not been configured. SECRET"));
    const result = await login({}, form());
    expect(result).toEqual({ error: "The request failed. Please try again." });
    expect(events()).toEqual([{ event: "request_failed", status: 500 }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });

  it("lets Next.js control flow through instead of reporting it as a failure", async () => {
    const control = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    m.server.mockRejectedValue(control);
    await expect(login({}, form())).rejects.toBe(control);
    expect(log).not.toHaveBeenCalled();
  });
});

// A session can end without the sign-out action (signed out or reset on another device, revoked, expired), which
// leaves that person's trading-account context cookies in the browser (§9.2). The next sign-in keeps only what belongs
// to the person signing in: someone else never starts in a context they cannot see nor sends those account ids with
// every request, and the same person signing in again keeps their remembered context.
describe("login: the trading-account context a previous session left", () => {
  const OWN = "20000000-0000-4000-8000-000000000001";
  const OWN_OTHER = "20000000-0000-4000-8000-000000000002";
  const FOREIGN = "30000000-0000-4000-8000-000000000003";
  const owns = (...ids: string[]) => m.accounts.mockResolvedValue({ data: ids.map(id => ({ id })), error: null });

  it("keeps the context of the same person signing in again, checked on the new session", async () => {
    m.cookies = [{ name: "tos_account", value: OWN }, { name: "tos_last_account", value: OWN_OTHER }, { name: "tos_theme", value: "dark" }];
    owns(OWN, OWN_OTHER);
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.accounts).toHaveBeenCalledExactlyOnceWith({ table: "accounts", select: "id", "eq.user_id": "u", "in.id": [OWN, OWN_OTHER] });
    expect(m.signIn.mock.invocationCallOrder[0]).toBeLessThan(m.from.mock.invocationCallOrder[0]);
    expect(m.deleted).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("removes another person's account ids, keeping display preferences", async () => {
    m.cookies = [{ name: "tos_account", value: FOREIGN }, { name: "tos_last_account", value: FOREIGN }, { name: "tos_theme", value: "dark" }];
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.accounts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ "eq.user_id": "u", "in.id": [FOREIGN] }));
    expect(m.deleted).toEqual(["tos_account", "tos_last_account"]);
  });

  it("keeps All Accounts and removes only the other person's most recently used account", async () => {
    m.cookies = [{ name: "tos_account", value: "all" }, { name: "tos_last_account", value: FOREIGN }];
    owns(OWN);
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.deleted).toEqual(["tos_last_account"]);
  });

  it("keeps one of the person's own accounts and removes the other person's", async () => {
    m.cookies = [{ name: "tos_account", value: FOREIGN }, { name: "tos_last_account", value: OWN.toUpperCase() }];
    owns(OWN);
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.accounts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ "in.id": [FOREIGN, OWN] }));
    expect(m.deleted).toEqual(["tos_account"]);
  });

  it("removes values that name no account without reading the database", async () => {
    m.cookies = [{ name: "tos_account", value: "not-an-account" }, { name: "tos_last_account", value: "all" }];
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.from).not.toHaveBeenCalled();
    expect(m.deleted).toEqual(["tos_account", "tos_last_account"]);
  });

  it("reads nothing when the browser has no context cookies", async () => {
    m.cookies = [{ name: "tos_theme", value: "dark" }];
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.from).not.toHaveBeenCalled();
    expect(m.deleted).toEqual([]);
  });

  it.each([
    ["answers with an error", () => m.accounts.mockResolvedValue({ data: null, error: { message: "PRIVATE permission denied" } })],
    ["fails", () => m.accounts.mockRejectedValue(new Error("PRIVATE fetch failed"))],
  ])("removes every account id when the accounts read %s, logs a fixed event and still signs in", async (_label, arrange) => {
    m.cookies = [{ name: "tos_account", value: OWN }, { name: "tos_last_account", value: OWN }];
    arrange();
    await expect(login({}, form())).rejects.toThrow("REDIRECT:/today");
    expect(m.deleted).toEqual(["tos_account", "tos_last_account"]);
    expect(events()).toEqual([{ event: "data_read_failed", status: 500 }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  });

  it("leaves the cookies alone when the sign-in fails", async () => {
    m.cookies = [{ name: "tos_account", value: FOREIGN }, { name: "tos_last_account", value: FOREIGN }];
    m.signIn.mockResolvedValue({ data: { user: null, session: null }, error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") });
    expect(await login({}, form())).toEqual({ error: SIGN_IN_FAILED });
    expect(m.from).not.toHaveBeenCalled();
    expect(m.deleted).toEqual([]);
  });
});

describe("logout", () => {
  const ACCOUNT = "20000000-0000-4000-8000-000000000001";

  it("signs this browser out, deletes the auth cookie chunks and the person's account context, and opens sign-in", async () => {
    m.cookies = [
      { name: "sb-127-auth-token", value: "a" },
      { name: "sb-127-auth-token.0", value: "b" },
      { name: "sb-127-auth-token-user", value: "c" },
      { name: "tos_theme", value: "dark" },
      { name: "tos_account", value: ACCOUNT },
      { name: "tos_last_account", value: ACCOUNT },
      { name: "tos_sidebar", value: "collapsed" },
    ];
    await expect(logout()).rejects.toThrow("REDIRECT:/login?reason=signed_out");
    expect(m.signOut).toHaveBeenCalledWith({ scope: "local" });
    // The next person to sign in on this browser starts in their own context (no "That trading account isn't available"
    // notice) and never sends this person's account ids; display preferences belong to the browser and stay.
    expect(m.deleted).toEqual(["sb-127-auth-token", "sb-127-auth-token.0", "sb-127-auth-token-user", "tos_account", "tos_last_account"]);
    expect(m.revalidate).toHaveBeenCalledWith("/", "layout");
  });

  it("clears the auth cookies and the account context even when the sign-out request fails", async () => {
    m.cookies = [{ name: "sb-127-auth-token", value: "a" }, { name: "tos_account", value: ACCOUNT }];
    m.signOut.mockRejectedValue(new Error("network"));
    await expect(logout()).rejects.toThrow("network");
    expect(m.deleted).toEqual(["sb-127-auth-token", "tos_account"]);
  });
});

describe("module surface", () => {
  it("exports only sign-in and sign-out: no V1 write action stays callable", () => {
    expect(Object.keys(actions).sort()).toEqual(["login", "logout"]);
  });
});
