import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVALID_RECOVERY, isRecentRecovery, RECOVERY_MESSAGE, RECOVERY_SESSION_EXPIRED, RECOVERY_SESSION_REQUIRED, RECOVERY_WINDOW_SECONDS, recoveryInput,
  recoveryRedirect,
} from "@/lib/password-recovery";

// Password recovery (src/app/password-actions.ts, src/lib/password-recovery.ts). V2 requires the current password to
// change the password of a signed-in login (docs/V2_ARCHITECTURE.md §14.11) and re-authentication before erasure
// (§10.4), so /update-password sets a password only on a session that a recovery link started within the last 15
// minutes (its JWT `amr` claim), on the page and again in the action, which can be called directly. Session tokens in
// a link are never adopted (session fixation): only the PKCE code, bound to the verifier cookie of this browser.

const NOW = new Date("2026-10-31T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const USER = "verified-user";
/** A trading account of USER, and one of someone else, as the context cookies may hold them. */
const OWN_ACCOUNT = "20000000-0000-4000-8000-000000000001";
const FOREIGN_ACCOUNT = "30000000-0000-4000-8000-000000000003";
const RECOVERY = [{ method: "recovery", timestamp: NOW_SECONDS - 60 }];
const PASSWORD = [{ method: "password", timestamp: NOW_SECONDS - 60 }];

const mock = vi.hoisted(() => ({
  reset: vi.fn(), exchange: vi.fn(), setSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(), update: vi.fn(), signOut: vi.fn(), deleteCookie: vi.fn(), server: vi.fn(),
  /** `db.from(table)`; the trading-accounts read resolves through `accounts` with its filters. */
  from: vi.fn(), accounts: vi.fn(),
  cookies: [] as { name: string; value: string }[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: mock.server }));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: () => ({ cookiePrefix: "sb-test-auth-token" }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://attacker.invalid" }), cookies: async () => ({ getAll: () => mock.cookies, delete: mock.deleteCookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import { completePasswordRecovery, requestPasswordRecovery, updatePassword } from "@/app/password-actions";

const form = (fields: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(fields)) data.set(key, value); return data; };
const NEW_PASSWORD = { password: "new-password-123", confirmation: "new-password-123" };
/** The verified claims of the browser's session. */
const session = (amr: unknown, sub = USER) => mock.getClaims.mockResolvedValue({ data: { claims: { sub, amr } }, error: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  for (const method of [mock.reset, mock.setSession, mock.update, mock.signOut]) method.mockResolvedValue({ data: {}, error: null });
  // The auth server answers a code exchange with the session and the user it signed in.
  mock.exchange.mockResolvedValue({ data: { user: { id: USER }, session: {} }, error: null });
  mock.getUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
  session(RECOVERY);
  mock.cookies = [
    { name: "sb-test-auth-token.0", value: "a" }, { name: "sb-test-auth-token-user", value: "b" }, { name: "tos_account", value: FOREIGN_ACCOUNT },
    { name: "tos_last_account", value: OWN_ACCOUNT }, { name: "tos_theme", value: "dark" }, { name: "unrelated", value: "c" },
  ];
  mock.from.mockImplementation((table: string) => {
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
      in: (column: string, values: unknown[]) => mock.accounts({ ...filters, [`in.${column}`]: values }),
    };
    return query;
  });
  mock.accounts.mockResolvedValue({ data: [{ id: OWN_ACCOUNT }], error: null });
  mock.server.mockResolvedValue({
    auth: { resetPasswordForEmail: mock.reset, exchangeCodeForSession: mock.exchange, setSession: mock.setSession, getUser: mock.getUser, getClaims: mock.getClaims, updateUser: mock.update, signOut: mock.signOut },
    from: mock.from,
  });
});
afterEach(() => vi.useRealTimers());

describe("recovery redirect and callback parsing", () => {
  it.each(["https://attacker.invalid", "http://localhost:3000", "https://trading-os-six-brown.vercel.app", null])("pins production redirect regardless of request origin %s", origin => expect(recoveryRedirect(origin, true)).toBe("https://trading-os-six-brown.vercel.app/update-password"));
  it.each(["http://localhost:3000", "http://127.0.0.1:3001"])("allows only loopback development origins %s", origin => expect(recoveryRedirect(origin, false)).toBe(`${origin}/update-password`));
  it.each(["http://localhost.attacker.test:3000", "http://user:pass@localhost:3000", "http://localhost:3000/evil", "javascript:alert(1)"])("ignores malicious development origins %s", origin => expect(recoveryRedirect(origin, false)).toBe("https://trading-os-six-brown.vercel.app/update-password"));
  it("takes a PKCE code and ignores a redirect injection", () => expect(recoveryInput("?code=one-time&next=https://attacker.invalid", "")).toEqual({ kind: "code", code: "one-time" }));
  it.each([
    ["", "#access_token=access&refresh_token=refresh&type=recovery"],
    ["", "#access_token=x&type=recovery"],
    ["", "#access_token=x&refresh_token=y&type=signup"],
    ["", "#refresh_token=y"],
    ["?access_token=x&refresh_token=y&type=recovery", ""],
    ["?code=one-time", "#access_token=x&refresh_token=y&type=recovery"],
  ])("never adopts session tokens from a link (session fixation): %s %s", (search, hash) => expect(recoveryInput(search, hash)).toEqual({ kind: "invalid", tokenLink: true }));
  it.each([["?error_code=otp_expired", ""], ["?code=", ""], ["", "#error=access_denied"], ["", "#error=access_denied&access_token=x&refresh_token=y"], ["?token_hash=x", ""]])("rejects malformed/expired callbacks %s %s", (search, hash) => expect(recoveryInput(search, hash)).toEqual({ kind: "invalid" }));
  it("leaves a visit without callback values to the browser's session", () => expect(recoveryInput("", "")).toEqual({ kind: "session" }));
});

describe("recent recovery session (amr)", () => {
  it("counts a recovery entry from the last 15 minutes only", () => {
    expect(RECOVERY_WINDOW_SECONDS).toBe(900);
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW_SECONDS }], NOW_SECONDS)).toBe(true);
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW_SECONDS - 900 }], NOW_SECONDS)).toBe(true);
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW_SECONDS - 901 }], NOW_SECONDS)).toBe(false);
    // A few minutes of difference between the auth server's clock and this one, never a timestamp far in the future.
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW_SECONDS + 120 }], NOW_SECONDS)).toBe(true);
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW_SECONDS + 3600 }], NOW_SECONDS)).toBe(false);
    // Any entry of the session may be the recovery (for example after a second factor).
    expect(isRecentRecovery([{ method: "totp", timestamp: NOW_SECONDS }, { method: "recovery", timestamp: NOW_SECONDS - 30 }], NOW_SECONDS)).toBe(true);
  });

  it.each([
    ["an ordinary sign-in", PASSWORD],
    ["a one-time code", [{ method: "otp", timestamp: NOW_SECONDS }]],
    ["the RFC 8176 string form, which has no time", ["recovery"]],
    ["a timestamp that is not a number", [{ method: "recovery", timestamp: String(NOW_SECONDS) }]],
    ["no amr claim", undefined],
    ["an empty claim", []],
    ["a malformed claim", [null, 1, "x"]],
  ])("never counts %s", (_label, amr) => expect(isRecentRecovery(amr, NOW_SECONDS)).toBe(false));
});

describe("recovery request", () => {
  it("validates email without contacting Supabase", async () => { expect((await requestPasswordRecovery({}, form({ email: "invalid" }))).error).toBeTruthy(); expect(mock.reset).not.toHaveBeenCalled(); });
  it("uses writable SSR cookies and the exact callback", async () => { expect(await requestPasswordRecovery({}, form({ email: "person@example.test" }))).toEqual({ success: RECOVERY_MESSAGE }); expect(mock.server).toHaveBeenCalledWith(true); expect(mock.reset).toHaveBeenCalledWith("person@example.test", { redirectTo: "https://trading-os-six-brown.vercel.app/update-password" }); });
  it.each(["user_not_found", "over_email_send_rate_limit", "email_address_not_authorized"])("does not enumerate recipients on %s", async code => { mock.reset.mockResolvedValue({ error: { code, message: "PRIVATE recipient" } }); expect(await requestPasswordRecovery({}, form({ email: "person@example.test" }))).toEqual({ success: RECOVERY_MESSAGE }); });
  it("does not expose thrown provider details", async () => { mock.reset.mockRejectedValue(new Error("PRIVATE token")); expect(await requestPasswordRecovery({}, form({ email: "person@example.test" }))).toEqual({ success: RECOVERY_MESSAGE }); });
});

describe("recovery session check (/update-password)", () => {
  it("exchanges PKCE using the existing writable cookie adapter, verifies the user, then reads the verified claims", async () => {
    expect(await completePasswordRecovery({ kind: "code", code: "one-time" })).toEqual({ success: "Choose your new password." });
    expect(mock.exchange).toHaveBeenCalledWith("one-time");
    expect(mock.getUser).toHaveBeenCalledOnce();
    expect(mock.getClaims).toHaveBeenCalledOnce();
    expect(mock.getUser.mock.invocationCallOrder[0]).toBeLessThan(mock.getClaims.mock.invocationCallOrder[0]);
    expect(mock.server).toHaveBeenCalledWith(true);
  });
  it("offers the form again on a reload while the recovery session is recent", async () => expect(await completePasswordRecovery({ kind: "session" })).toEqual({ success: "Choose your new password." }));
  it("sends a signed-in person without a recovery link to Settings → Security instead of offering the form", async () => {
    session(PASSWORD);
    expect(await completePasswordRecovery({ kind: "session" })).toEqual({ error: RECOVERY_SESSION_REQUIRED, signedIn: true });
    expect(RECOVERY_SESSION_REQUIRED).toContain("Settings → Security");
  });
  it("treats a recovery session older than 15 minutes like any signed-in session", async () => {
    session([{ method: "recovery", timestamp: NOW_SECONDS - RECOVERY_WINDOW_SECONDS - 1 }]);
    expect(await completePasswordRecovery({ kind: "session" })).toEqual({ error: RECOVERY_SESSION_REQUIRED, signedIn: true });
  });
  it("refuses a code that did not start a recovery session", async () => { session(PASSWORD); expect(await completePasswordRecovery({ kind: "code", code: "one-time" })).toEqual({ error: INVALID_RECOVERY }); });
  it("never adopts session tokens, even when a client sends them", async () => {
    expect(await completePasswordRecovery({ kind: "tokens", access_token: "attacker-access", refresh_token: "attacker-refresh" })).toEqual({ error: INVALID_RECOVERY });
    expect(mock.server).not.toHaveBeenCalled();
    expect(mock.setSession).not.toHaveBeenCalled();
  });
  it("does not fall back to an existing user after a failed/expired code", async () => {
    mock.exchange.mockResolvedValue({ data: { user: null, session: null }, error: { message: "PRIVATE code" } });
    expect(await completePasswordRecovery({ kind: "code", code: "expired" })).toEqual({ error: INVALID_RECOVERY });
    expect(mock.getUser).not.toHaveBeenCalled();
    // Nothing signed this browser in: the trading-account context stays as it was.
    expect(mock.from).not.toHaveBeenCalled();
    expect(mock.deleteCookie).not.toHaveBeenCalled();
  });
  // A recovery link's code signs this browser in, like the password sign-in (src/app/actions.ts): a session that ended
  // without signing out may have left someone else's trading-account context cookies here (§9.2).
  it("keeps only the context cookies of the person the recovery link signed in", async () => {
    expect(await completePasswordRecovery({ kind: "code", code: "one-time" })).toEqual({ success: "Choose your new password." });
    expect(mock.accounts).toHaveBeenCalledExactlyOnceWith({ table: "accounts", select: "id", "eq.user_id": USER, "in.id": [FOREIGN_ACCOUNT, OWN_ACCOUNT] });
    expect(mock.exchange.mock.invocationCallOrder[0]).toBeLessThan(mock.from.mock.invocationCallOrder[0]);
    expect(mock.deleteCookie.mock.calls.map(c => c[0])).toEqual(["tos_account"]);
  });
  it("also cleans the context when the code turns out not to be a recovery", async () => {
    session(PASSWORD);
    mock.accounts.mockResolvedValue({ data: [], error: null });
    expect(await completePasswordRecovery({ kind: "code", code: "one-time" })).toEqual({ error: INVALID_RECOVERY });
    expect(mock.deleteCookie.mock.calls.map(c => c[0])).toEqual(["tos_account", "tos_last_account"]);
  });
  it("leaves the context cookies alone on a reload, which signs nobody in", async () => {
    expect(await completePasswordRecovery({ kind: "session" })).toEqual({ success: "Choose your new password." });
    expect(mock.from).not.toHaveBeenCalled();
    expect(mock.deleteCookie).not.toHaveBeenCalled();
  });
  it("rejects an invalid callback before touching an existing session", async () => { expect(await completePasswordRecovery({ kind: "invalid" })).toEqual({ error: INVALID_RECOVERY }); expect(mock.server).not.toHaveBeenCalled(); });
  it("rejects signed-out and revoked sessions without reading claims", async () => { mock.getUser.mockResolvedValue({ data: { user: null }, error: null }); expect(await completePasswordRecovery({ kind: "session" })).toEqual({ error: INVALID_RECOVERY }); expect(mock.getClaims).not.toHaveBeenCalled(); });
  it("rejects claims that cannot be verified or belong to another user", async () => {
    mock.getClaims.mockResolvedValue({ data: null, error: { message: "invalid JWT" } });
    expect(await completePasswordRecovery({ kind: "session" })).toEqual({ error: INVALID_RECOVERY });
    session(RECOVERY, "someone-else");
    expect(await completePasswordRecovery({ kind: "session" })).toEqual({ error: INVALID_RECOVERY });
  });
  it("does not leak details from a failed check", async () => { mock.getClaims.mockRejectedValue(new Error("PRIVATE refresh token")); expect(JSON.stringify(await completePasswordRecovery({ kind: "session" }))).not.toContain("PRIVATE"); });
});

describe("password update", () => {
  it.each([{ password: "short", confirmation: "short" }, { password: "new-password-123", confirmation: "different" }])("rejects invalid password or confirmation", async values => { expect((await updatePassword({}, form(values))).error).toBeTruthy(); expect(mock.update).not.toHaveBeenCalled(); });
  it("reauthorizes the session on submission", async () => { mock.getUser.mockResolvedValue({ data: { user: null }, error: null }); expect(await updatePassword({}, form(NEW_PASSWORD))).toEqual({ error: INVALID_RECOVERY }); expect(mock.update).not.toHaveBeenCalled(); });

  it.each([
    ["an ordinary password session (no current password, no recovery link)", PASSWORD],
    ["a recovery session older than 15 minutes", [{ method: "recovery", timestamp: NOW_SECONDS - RECOVERY_WINDOW_SECONDS - 1 }]],
    ["claims in the RFC 8176 string form", ["recovery"]],
  ])("refuses %s: nothing changes, nobody is signed out", async (_label, amr) => {
    session(amr);
    expect(await updatePassword({}, form(NEW_PASSWORD))).toEqual({ error: RECOVERY_SESSION_EXPIRED });
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(mock.deleteCookie).not.toHaveBeenCalled();
  });

  it("refuses a recovery session that expired while the form was open (the clock moves on)", async () => {
    vi.setSystemTime(new Date(NOW.getTime() + RECOVERY_WINDOW_SECONDS * 1000));
    expect(await updatePassword({}, form(NEW_PASSWORD))).toEqual({ error: RECOVERY_SESSION_EXPIRED });
    expect(mock.update).not.toHaveBeenCalled();
  });

  it("updates through Supabase user auth, clears auth and context cookies and redirects only to login", async () => {
    await expect(updatePassword({}, form({ ...NEW_PASSWORD, next: "https://attacker.invalid" }))).rejects.toThrow("REDIRECT:/login?reason=password_updated");
    expect(mock.update).toHaveBeenCalledWith({ password: "new-password-123" });
    expect(mock.signOut).toHaveBeenCalledWith({ scope: "global" });
    // The next person on this browser starts in their own trading-account context; display preferences stay.
    expect(mock.deleteCookie.mock.calls.map(c => c[0])).toEqual(["sb-test-auth-token.0", "sb-test-auth-token-user", "tos_account", "tos_last_account"]);
  });
  it("still clears local cookies if remote sign-out is unavailable", async () => { mock.signOut.mockRejectedValue(new Error("unavailable")); await expect(updatePassword({}, form(NEW_PASSWORD))).rejects.toThrow("REDIRECT:/login?reason=password_updated"); expect(mock.deleteCookie).toHaveBeenCalledTimes(4); });
  it.each(["weak_password", "same_password", "session_not_found"])("returns useful safe errors for %s", async code => { mock.update.mockResolvedValue({ error: { code, message: "PRIVATE password" } }); const result = await updatePassword({}, form(NEW_PASSWORD)); expect(result.error).toBeTruthy(); expect(result.error).not.toContain("PRIVATE"); expect(mock.signOut).not.toHaveBeenCalled(); });
});
