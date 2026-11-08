import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Public sign-in pages restyled for V2 (docs/V2_ARCHITECTURE.md §14.12): truthful copy (invitation-only, no broker
// execution), the four reason notices, the stored theme, and the unchanged security behaviour (a signed-in visitor
// goes to Today; the new-password form appears only after the recovery session is verified).

const m = vi.hoisted(() => ({
  configured: vi.fn(),
  getUser: vi.fn(),
  server: vi.fn(),
  cookie: vi.fn(),
  action: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ isConfigured: m.configured, supabaseServer: m.server }));
vi.mock("@/lib/account-context", () => ({ THEME_COOKIE: "tos_theme" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name === "tos_theme" ? m.cookie() : undefined) }) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("@/app/actions", () => ({ login: m.action }));
vi.mock("@/app/password-actions", () => ({ requestPasswordRecovery: m.action, updatePassword: m.action, completePasswordRecovery: m.action }));

import ForgotPasswordPage from "@/app/forgot-password/page";
import LoginPage from "@/app/login/page";
import UpdatePasswordPage from "@/app/update-password/page";
import { RecoveryView } from "@/components/password-recovery";
import { SIGN_IN_NOTICES } from "@/components/settings/auth-page-data";
import { INVALID_RECOVERY, RECOVERY_SESSION_REQUIRED, UNSUPPORTED_RECOVERY_LINK } from "@/lib/password-recovery";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const login = async (reason?: string | string[]) => renderToStaticMarkup((await LoginPage({ searchParams: Promise.resolve({ reason }) })) as ReactElement);

function expectTruthful(html: string) {
  const text = visibleText(html);
  expect(text).toContain("Trading OS records plans, decisions and results. It never connects to a broker to place or change trades.");
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(text).not.toMatch(UUID);
  expect(html).not.toMatch(ENUM);
  // The legacy preview no longer exists in V2 (/preview redirects to /login).
  expect(html).not.toContain('href="/preview"');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.configured.mockReturnValue(true);
  m.getUser.mockResolvedValue({ data: { user: null }, error: null });
  m.server.mockResolvedValue({ auth: { getUser: m.getUser } });
  m.cookie.mockReturnValue(undefined);
});

describe("/login", () => {
  it("signs in with email and password, invitation-only, with the recovery link next to the password", async () => {
    const html = await login();
    const text = visibleText(html);
    expect(text).toContain("Sign in to Trading OS");
    expect(text).toContain("Access is invitation-only. Use the login provisioned for you.");
    expect(html).toMatch(/<input[^>]*autoComplete="username"[^>]*name="email"|<input[^>]*name="email"[^>]*autoComplete="username"/);
    expect(html).toMatch(/autoComplete="current-password"/);
    expect(html).toContain('href="/forgot-password"');
    expect(text).toContain("Sign in");
    expectTruthful(html);
  });

  it.each(Object.entries(SIGN_IN_NOTICES))("explains why the visitor is here: %s", async (reason, notice) => {
    const html = await login(reason);
    expect(visibleText(html)).toContain(notice.title);
    if (notice.body) expect(visibleText(html)).toContain(notice.body);
    expect(html).toMatch(/role="status"/);
  });

  it("shows the four reason notices with exact copy", () => {
    expect(Object.keys(SIGN_IN_NOTICES)).toEqual(["session", "signed_out", "password_updated", "account_deleted"]);
    expect(SIGN_IN_NOTICES.account_deleted.title).toBe("Your Trading OS account was deleted");
    expect(SIGN_IN_NOTICES.password_updated.body).toBe("Sign in with your new password.");
    // Sign-in always opens Today, so the notice promises nothing about returning to the page the session ended on.
    expect(SIGN_IN_NOTICES.session.title).toBe("Your session ended");
    expect(SIGN_IN_NOTICES.session.body).toBe("Sign in again to continue.");
  });

  it("never promises to return to the page where the session ended", async () => {
    const text = visibleText(await login("session"));
    expect(text).toContain("Your session ended Sign in again to continue.");
    expect(text).not.toMatch(/where you left off|continue where/i);
  });

  it.each([["unknown"], [["session", "signed_out"]], [undefined]])("shows no notice for %j", async reason => {
    const html = await login(reason as string | string[] | undefined);
    for (const notice of Object.values(SIGN_IN_NOTICES)) expect(visibleText(html)).not.toContain(notice.title);
  });

  it("sends a signed-in visitor straight to Today", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(login()).rejects.toThrow("REDIRECT:/today");
  });

  it("explains an unconfigured deployment without a form or any auth call", async () => {
    m.configured.mockReturnValue(false);
    const html = await login();
    expect(visibleText(html)).toContain("Sign-in isn't set up yet");
    expect(visibleText(html)).toContain("README.md");
    expect(html).not.toContain('name="password"');
    expect(m.server).not.toHaveBeenCalled();
    expectTruthful(html);
  });

  it("honours the theme stored in Settings, and follows the device otherwise", async () => {
    m.cookie.mockReturnValue({ value: "dark" });
    expect(await login()).toContain('data-theme="dark"');
    m.cookie.mockReturnValue({ value: "system" });
    expect(await login()).not.toContain("data-theme=");
    m.cookie.mockReturnValue({ value: "<script>" });
    expect(await login()).not.toContain("data-theme=");
  });
});

describe("/forgot-password", () => {
  it("requests a recovery link by email and leads back to sign-in", async () => {
    const html = renderToStaticMarkup(await ForgotPasswordPage());
    const text = visibleText(html);
    expect(text).toContain("Reset your password");
    expect(text).toContain("Open the newest link in this browser.");
    expect(html).toContain('name="email"');
    expect(text).toContain("Send recovery link");
    expect(html).toContain('href="/login"');
    expectTruthful(html);
  });
});

describe("/update-password", () => {
  it("verifies the recovery link before offering the new-password form", async () => {
    const html = renderToStaticMarkup(await UpdatePasswordPage());
    const text = visibleText(html);
    expect(text).toContain("Set a new password");
    expect(text).toContain("Checking your recovery link…");
    expect(html).toContain('role="status"');
    expect(html).not.toContain('name="password"');
    expect(html).toContain('href="/login"');
    expect(m.action).not.toHaveBeenCalled();
    expectTruthful(html);
  });

  // What the page shows once the server answered (src/app/password-actions.ts completePasswordRecovery).
  const view = (state: Parameters<typeof RecoveryView>[0]["state"]) => renderToStaticMarkup(createElement(RecoveryView, { state }));

  it("offers the new-password form only after a recent recovery session was verified", () => {
    const html = view({ success: "Choose your new password." });
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirmation"');
    expect(visibleText(html)).toContain("Update password");
    expect(html).toContain('href="/forgot-password"');
  });

  it("sends a signed-in visitor without a recent recovery link to Settings → Security, with no new-password form", () => {
    // V2 §14.11: a signed-in login changes its password only with the current one, which Settings asks for.
    const html = view({ error: RECOVERY_SESSION_REQUIRED, signedIn: true });
    const text = visibleText(html);
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('name="confirmation"');
    expect(text).toContain("Change your password in Settings");
    expect(text).toContain(RECOVERY_SESSION_REQUIRED);
    expect(html).toContain('href="/settings#security"');
    expect(text).toContain("Forgot your current password?");
    expect(html).toContain('href="/forgot-password"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it.each([
    ["a link carrying session tokens (never adopted)", UNSUPPORTED_RECOVERY_LINK],
    ["an invalid or expired link", INVALID_RECOVERY],
  ])("refuses %s and offers a new recovery link instead of the form", (_label, error) => {
    const html = view({ error });
    const text = visibleText(html);
    expect(html).not.toContain('name="password"');
    expect(text).toContain("This link can't be used");
    expect(text).toContain(error);
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain('href="/login"');
  });
});
