import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_MESSAGE, INVALID_RECOVERY, recoveryInput, recoveryRedirect } from "@/lib/password-recovery";
const mock = vi.hoisted(() => ({ reset: vi.fn(), exchange: vi.fn(), setSession: vi.fn(), getUser: vi.fn(), update: vi.fn(), signOut: vi.fn(), deleteCookie: vi.fn(), server: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: mock.server }));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: () => ({ cookiePrefix: "sb-test-auth-token" }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://attacker.invalid" }), cookies: async () => ({ getAll: () => [{ name: "sb-test-auth-token.0" }, { name: "sb-test-auth-token-user" }, { name: "unrelated" }], delete: mock.deleteCookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import { completePasswordRecovery, requestPasswordRecovery, updatePassword } from "@/app/password-actions";
const form = (fields: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(fields)) data.set(key, value); return data; };
beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [mock.reset, mock.exchange, mock.setSession, mock.update, mock.signOut]) method.mockResolvedValue({ data: {}, error: null });
  mock.getUser.mockResolvedValue({ data: { user: { id: "verified-user" } }, error: null });
  mock.server.mockResolvedValue({ auth: { resetPasswordForEmail: mock.reset, exchangeCodeForSession: mock.exchange, setSession: mock.setSession, getUser: mock.getUser, updateUser: mock.update, signOut: mock.signOut } });
});
describe("recovery redirect and callback parsing", () => {
  it.each(["https://attacker.invalid", "http://localhost:3000", "https://trading-os-six-brown.vercel.app", null])("pins production redirect regardless of request origin %s", origin => expect(recoveryRedirect(origin, true)).toBe("https://trading-os-six-brown.vercel.app/update-password"));
  it.each(["http://localhost:3000", "http://127.0.0.1:3001"])("allows only loopback development origins %s", origin => expect(recoveryRedirect(origin, false)).toBe(`${origin}/update-password`));
  it.each(["http://localhost.attacker.test:3000", "http://user:pass@localhost:3000", "http://localhost:3000/evil", "javascript:alert(1)"])("ignores malicious development origins %s", origin => expect(recoveryRedirect(origin, false)).toBe("https://trading-os-six-brown.vercel.app/update-password"));
  it("takes a PKCE code and ignores a redirect injection", () => expect(recoveryInput("?code=one-time&next=https://attacker.invalid", "")).toEqual({ kind: "code", code: "one-time" }));
  it("accepts recovery fragments for existing dashboard links", () => expect(recoveryInput("", "#access_token=access&refresh_token=refresh&type=recovery")).toEqual({ kind: "tokens", access_token: "access", refresh_token: "refresh" }));
  it.each([["?error_code=otp_expired", ""], ["?code=", ""], ["", "#error=access_denied"], ["", "#access_token=x&type=recovery"], ["", "#access_token=x&refresh_token=y&type=signup"], ["?token_hash=x", ""]])("rejects malformed/expired callbacks %s %s", (search, hash) => expect(recoveryInput(search, hash)).toEqual({ kind: "invalid" }));
  it("supports an existing authenticated session without callback credentials", () => expect(recoveryInput("", "")).toEqual({ kind: "session" }));
});
describe("recovery request", () => {
  it("validates email without contacting Supabase", async () => { expect((await requestPasswordRecovery({}, form({ email: "invalid" }))).error).toBeTruthy(); expect(mock.reset).not.toHaveBeenCalled(); });
  it("uses writable SSR cookies and the exact callback", async () => { expect(await requestPasswordRecovery({}, form({ email: "person@example.test" }))).toEqual({ success: RECOVERY_MESSAGE }); expect(mock.server).toHaveBeenCalledWith(true); expect(mock.reset).toHaveBeenCalledWith("person@example.test", { redirectTo: "https://trading-os-six-brown.vercel.app/update-password" }); });
  it.each(["user_not_found", "over_email_send_rate_limit", "email_address_not_authorized"])("does not enumerate recipients on %s", async code => { mock.reset.mockResolvedValue({ error: { code, message: "PRIVATE recipient" } }); expect(await requestPasswordRecovery({}, form({ email: "person@example.test" }))).toEqual({ success: RECOVERY_MESSAGE }); });
  it("does not expose thrown provider details", async () => { mock.reset.mockRejectedValue(new Error("PRIVATE token")); expect(await requestPasswordRecovery({}, form({ email: "person@example.test" }))).toEqual({ success: RECOVERY_MESSAGE }); });
});
describe("recovery session exchange", () => {
  it("exchanges PKCE using the existing writable cookie adapter and verifies user", async () => { expect((await completePasswordRecovery({ kind: "code", code: "one-time" })).success).toBeTruthy(); expect(mock.exchange).toHaveBeenCalledWith("one-time"); expect(mock.getUser).toHaveBeenCalledOnce(); expect(mock.server).toHaveBeenCalledWith(true); });
  it("converts an implicit recovery session into verified SSR cookies", async () => { expect((await completePasswordRecovery({ kind: "tokens", access_token: "access", refresh_token: "refresh" })).success).toBeTruthy(); expect(mock.setSession).toHaveBeenCalledWith({ access_token: "access", refresh_token: "refresh" }); expect(mock.getUser).toHaveBeenCalledOnce(); });
  it("does not fall back to an existing user after a failed/expired code", async () => { mock.exchange.mockResolvedValue({ error: { message: "PRIVATE code" } }); expect(await completePasswordRecovery({ kind: "code", code: "expired" })).toEqual({ error: INVALID_RECOVERY }); expect(mock.getUser).not.toHaveBeenCalled(); });
  it("rejects an invalid callback before touching an existing session", async () => { expect(await completePasswordRecovery({ kind: "invalid" })).toEqual({ error: INVALID_RECOVERY }); expect(mock.server).not.toHaveBeenCalled(); });
  it("rejects signed-out and revoked sessions", async () => { mock.getUser.mockResolvedValue({ data: { user: null }, error: null }); expect(await completePasswordRecovery({ kind: "session" })).toEqual({ error: INVALID_RECOVERY }); });
  it("does not leak token details from failed session establishment", async () => { mock.setSession.mockRejectedValue(new Error("PRIVATE refresh token")); expect(JSON.stringify(await completePasswordRecovery({ kind: "tokens", access_token: "access", refresh_token: "refresh" }))).not.toContain("PRIVATE"); });
});
describe("password update", () => {
  it.each([{ password: "short", confirmation: "short" }, { password: "new-password-123", confirmation: "different" }])("rejects invalid password or confirmation", async values => { expect((await updatePassword({}, form(values))).error).toBeTruthy(); expect(mock.update).not.toHaveBeenCalled(); });
  it("reauthorizes the session on submission", async () => { mock.getUser.mockResolvedValue({ data: { user: null }, error: null }); expect(await updatePassword({}, form({ password: "new-password-123", confirmation: "new-password-123" }))).toEqual({ error: INVALID_RECOVERY }); expect(mock.update).not.toHaveBeenCalled(); });
  it("updates through Supabase user auth, clears auth cookies and redirects only to login", async () => { await expect(updatePassword({}, form({ password: "new-password-123", confirmation: "new-password-123", next: "https://attacker.invalid" }))).rejects.toThrow("REDIRECT:/login?reason=password_updated"); expect(mock.update).toHaveBeenCalledWith({ password: "new-password-123" }); expect(mock.signOut).toHaveBeenCalledWith({ scope: "global" }); expect(mock.deleteCookie.mock.calls.map(c => c[0])).toEqual(["sb-test-auth-token.0", "sb-test-auth-token-user"]); });
  it("still clears local cookies if remote sign-out is unavailable", async () => { mock.signOut.mockRejectedValue(new Error("unavailable")); await expect(updatePassword({}, form({ password: "new-password-123", confirmation: "new-password-123" }))).rejects.toThrow("REDIRECT:/login?reason=password_updated"); expect(mock.deleteCookie).toHaveBeenCalledTimes(2); });
  it.each(["weak_password", "same_password", "session_not_found"])("returns useful safe errors for %s", async code => { mock.update.mockResolvedValue({ error: { code, message: "PRIVATE password" } }); const result = await updatePassword({}, form({ password: "new-password-123", confirmation: "new-password-123" })); expect(result.error).toBeTruthy(); expect(result.error).not.toContain("PRIVATE"); expect(mock.signOut).not.toHaveBeenCalled(); });
});
