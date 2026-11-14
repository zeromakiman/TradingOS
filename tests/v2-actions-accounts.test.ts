import { beforeEach, describe, expect, it, vi } from "vitest";

// V2 account, context and settings server actions (docs/V2_ARCHITECTURE.md §3.2, §3.9–3.10, §8.4, §9.2, §13.9,
// §14.9, §14.11): schema gate, validation with field copy, exact RPC payloads, cookie attributes of the context and
// preference cookies, and the password change that re-authenticates with a separate, non-persisting client.

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  revalidate: vi.fn(),
  rethrow: vi.fn(),
  log: vi.fn(),
  session: null as unknown,
  jar: new Map<string, string>(),
  cookieSets: [] as [string, string, Record<string, unknown>][],
  cookieDeletes: [] as string[],
  headers: new Map<string, string>(),
  createClient: vi.fn(),
  logout: vi.fn(),
  browser: {
    auth: {
      setSession: vi.fn(async (_tokens: unknown): Promise<{ data: unknown; error: Error | null }> => ({ data: {}, error: null })),
      signOut: vi.fn(async (_options: unknown): Promise<{ error: Error | null }> => ({ error: null })),
    },
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ unstable_rethrow: m.rethrow }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (m.jar.has(name) ? { name, value: m.jar.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => { m.cookieSets.push([name, value, options]); m.jar.set(name, value); },
    delete: (name: string) => { m.cookieDeletes.push(name); m.jar.delete(name); },
  }),
  headers: async () => ({ get: (name: string) => m.headers.get(name) ?? null }),
}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => m.session, supabaseServer: async () => m.browser }));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: () => ({ url: "https://project.supabase.co", key: "sb_publishable_test", cookiePrefix: "sb-project-auth-token" }) }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.log }));
vi.mock("@supabase/supabase-js", async importOriginal => ({ ...(await importOriginal<typeof import("@supabase/supabase-js")>()), createClient: m.createClient }));
vi.mock("@/app/actions", () => ({ logout: m.logout }));

import {
  addExternalLoss, archiveAccount, confirmAccountValuesUnchanged, createInstrument, createRiskPolicyVersion, createTradingAccount, recordAccountValues,
  removeExternalLoss, restoreAccount, updateProfile,
} from "@/app/actions/accounts";
import { setAccountContext, setDeveloperMode, setTheme, setTimeDisplay, signOut } from "@/app/actions/context";
import { changePassword } from "@/app/actions/settings";
import { idleState } from "@/app/actions/state";

class Chain {
  private readonly predicates: ((row: Row) => boolean)[] = [];
  private single = false;
  constructor(private readonly rows: Row[]) {}
  select(): this { return this; }
  eq(column: string, value: unknown): this { this.predicates.push(row => row[column] === value); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  maybeSingle(): this { this.single = true; return this; }
  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A>(resolve: (value: { data: unknown; error: null }) => A): Promise<A> {
    const rows = this.rows.filter(row => this.predicates.every(predicate => predicate(row)));
    return Promise.resolve({ data: this.single ? rows[0] ?? null : rows, error: null }).then(resolve);
  }
}

class ActionDb {
  readonly results: Record<string, (args: Row) => { data: unknown; error: { message: string; code?: string } | null }> = {
    trading_os_schema: () => ({ data: "2.1", error: null }),
  };
  readonly rpc = vi.fn(async (fn: string, args: Row = {}) => this.results[fn]?.(args) ?? { data: null, error: { message: `unexpected rpc ${fn}` } });
  readonly auth = { signOut: vi.fn(async () => ({ error: null })) };
  constructor(readonly tables: Record<string, Row[]> = {}) {}
  from(table: string): Chain { return new Chain(this.tables[table] ?? []); }
  calls(fn: string): Row[] { return this.rpc.mock.calls.filter(call => call[0] === fn).map(call => call[1] as Row); }
  writes(): string[] { return this.rpc.mock.calls.map(call => call[0]).filter(fn => fn !== "trading_os_schema"); }
}

const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const ARCHIVED = "20000000-0000-4000-8000-000000000002";
const KEY = "70000000-0000-4000-8000-000000000001";
const OBS = "60000000-0000-4000-8000-000000000001";
const LOSS = "f0000000-0000-4000-8000-000000000001";
const INVALID = "Some values need attention. Check the highlighted fields.";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

let db: ActionDb;
function useDb(tables: Record<string, Row[]> = {}): ActionDb {
  db = new ActionDb({
    accounts: [
      { id: ACCOUNT, user_id: USER, name: "FTMO", currency: "USD", created_at: "2026-09-01T10:00:00.000Z" },
      { id: ARCHIVED, user_id: USER, name: "Old", currency: "USD", created_at: "2026-09-01T10:00:00.000Z" },
    ],
    account_profiles: [
      { id: 1, account_id: ACCOUNT, user_id: USER, display_name: "FTMO", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: null, status: "ACTIVE" },
      { id: 2, account_id: ARCHIVED, user_id: USER, display_name: "Old", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: null, status: "ARCHIVED" },
    ],
    ...tables,
  });
  m.session = { db, user: { id: USER, email: "trader@example.test" } };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.jar.clear();
  m.cookieSets.length = 0;
  m.cookieDeletes.length = 0;
  m.headers.clear();
  useDb();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("trading accounts (§3.2)", () => {
  const valid = { requestKey: KEY, name: " FTMO 100K ", currency: "EUR", accountType: "EVALUATION", platform: "MT5", balance: "100000", equity: "100000.00" };

  it("creates an account with only the given fields and makes it the forms' default", async () => {
    db.results.create_trading_account = () => ({ data: ACCOUNT, error: null });
    expect(await createTradingAccount(idleState, form({ ...valid, broker: " " }))).toEqual({
      status: "success", message: "Trading account created with the ICT V1.0 strategy and Risk Plan V1.0.", data: { accountId: ACCOUNT },
    });
    expect(db.calls("create_trading_account")[0]).toEqual({
      p_request_key: KEY, p_input: { name: "FTMO 100K", currency: "EUR", accountType: "EVALUATION", platform: "MT5", balance: "100000", equity: "100000.00" },
    });
    expect(m.cookieSets).toEqual([["tos_last_account", ACCOUNT, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 34560000, secure: false }]]);
    expect(m.revalidate).toHaveBeenCalledWith("/", "layout");
  });

  it("validates before writing", async () => {
    expect(await createTradingAccount(idleState, form({ ...valid, currency: "BTC", balance: "-1", startingBalance: "1.001" }))).toEqual({
      status: "error", message: INVALID, fieldErrors: {
        currency: "Choose the account currency.", balance: "Balance must be a positive amount with up to 2 decimals.",
        startingBalance: "Starting balance must be a positive amount with up to 2 decimals.",
      },
    });
    expect(db.writes()).toEqual([]);
  });

  it("reports non-numeric amounts as field errors instead of failing the request", async () => {
    expect(await createTradingAccount(idleState, form({ ...valid, balance: "abc", equity: "", startingBalance: "1,5" }))).toEqual({
      status: "error", message: INVALID, fieldErrors: {
        balance: "Balance must be a positive amount with up to 2 decimals.", equity: "Equity must be a positive amount with up to 2 decimals.",
        startingBalance: "Starting balance must be a positive amount with up to 2 decimals.",
      },
    });
    expect(await createRiskPolicyVersion(idleState, form({ accountId: ACCOUNT, maxRiskPercent: "x", defaultRiskPercent: "", maxDailyTrades: "3", minRR: "2,5", rrPolicy: "WARN", newsPolicy: "BLOCK" }))).toMatchObject({
      status: "error", message: INVALID, fieldErrors: { maxRiskPercent: expect.any(String), defaultRiskPercent: expect.any(String), minRR: expect.any(String) },
    });
    expect(db.writes()).toEqual([]);
    expect(m.log).not.toHaveBeenCalled();
  });

  it("refuses to write without the 2.0 schema", async () => {
    db.results.trading_os_schema = () => ({ data: "1.0", error: null });
    expect(await createTradingAccount(idleState, form(valid))).toEqual({
      status: "error", message: "Database update required — this deployment expects Trading OS database version 2.1. No changes were made.",
    });
    expect(db.writes()).toEqual([]);
  });

  it("changes only the profile fields present in the form; an empty broker clears it", async () => {
    db.results.update_account_profile = () => ({ data: 3, error: null });
    expect(await updateProfile(idleState, form({ accountId: ACCOUNT, displayName: "FTMO Challenge", broker: "" }))).toMatchObject({ status: "success" });
    expect(db.calls("update_account_profile")[0]).toEqual({ p_account_id: ACCOUNT, p_input: { displayName: "FTMO Challenge", broker: null } });
    expect(await updateProfile(idleState, form({ accountId: ACCOUNT }))).toEqual({ status: "error", message: "Change at least one detail of the profile." });
    expect(await updateProfile(idleState, form({ accountId: ACCOUNT, displayName: "" }))).toMatchObject({ status: "error", fieldErrors: { displayName: "Name the account (1 to 100 characters)." } });
  });

  it("archiving moves the context off the account; restoring re-activates it", async () => {
    db.results.update_account_profile = () => ({ data: 4, error: null });
    m.jar.set("tos_account", ACCOUNT);
    m.jar.set("tos_last_account", ACCOUNT);
    expect(await archiveAccount(idleState, form({ accountId: ACCOUNT }))).toEqual({ status: "success", message: "Account archived. It takes no new trades; its history stays." });
    expect(db.calls("update_account_profile")[0]).toEqual({ p_account_id: ACCOUNT, p_input: { status: "ARCHIVED" } });
    expect(m.jar.get("tos_account")).toBe("all");
    expect(m.cookieDeletes).toEqual(["tos_last_account"]);
    expect(await restoreAccount(idleState, form({ accountId: ACCOUNT }))).toMatchObject({ status: "success" });
    expect(db.calls("update_account_profile")[1]).toEqual({ p_account_id: ACCOUNT, p_input: { status: "ACTIVE" } });
  });

  it("creates an instrument version valued in the account currency", async () => {
    db.results.create_instrument_version = () => ({ data: KEY, error: null });
    expect(await createInstrument(idleState, form({ accountId: ACCOUNT, symbol: "xauusd", quantityUnit: "lots (100 oz)", tickSize: "0.01", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" }))).toMatchObject({
      status: "success", data: { instrumentId: KEY },
    });
    expect(db.calls("create_instrument_version")[0]).toEqual({
      p_account_id: ACCOUNT, p_input: { symbol: "XAUUSD", quantityUnit: "lots (100 oz)", tickSize: "0.01", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("account values and external losses (§8.4)", () => {
  it("records values and confirms unchanged values with the latest observation", async () => {
    useDb({ account_observations: [{ id: OBS, account_id: ACCOUNT, user_id: USER, balance: "10000.00", equity: "9990.50", gross_loss_today: null, trading_day: "2026-10-13", recorded_at: "2026-10-13T12:00:00.000Z" }] });
    db.results.record_account_values = () => ({ data: KEY, error: null });
    expect(await recordAccountValues(idleState, form({ accountId: ACCOUNT, balance: "10100", equity: "10050.25" }))).toEqual({ status: "success", message: "Account values recorded for today." });
    expect(db.calls("record_account_values")[0]).toEqual({ p_account_id: ACCOUNT, p_balance: "10100", p_equity: "10050.25" });
    expect(await confirmAccountValuesUnchanged(idleState, form({ accountId: ACCOUNT, observationId: OBS }))).toEqual({ status: "success", message: "Balance confirmed for today." });
    expect(db.calls("record_account_values")[1]).toEqual({ p_account_id: ACCOUNT, p_balance: "10000", p_equity: "9990.5" });
    expect(await confirmAccountValuesUnchanged(idleState, form({ accountId: ACCOUNT, observationId: KEY }))).toMatchObject({
      status: "error", message: "Account values changed since this page loaded. Reload and confirm again.",
    });
  });

  it("adds and removes external losses", async () => {
    useDb({ external_loss_entries: [{ id: LOSS, account_id: ACCOUNT, user_id: USER }] });
    db.results.add_external_loss = () => ({ data: LOSS, error: null });
    db.results.remove_external_loss = () => ({ data: null, error: null });
    expect(await addExternalLoss(idleState, form({ accountId: ACCOUNT, amount: "12.50", note: "cTrader scalp", requestKey: KEY }))).toMatchObject({ status: "success", data: { entryId: LOSS } });
    expect(db.calls("add_external_loss")[0]).toEqual({ p_account_id: ACCOUNT, p_amount: "12.50", p_note: "cTrader scalp", p_request_key: KEY });
    expect((await addExternalLoss(idleState, form({ accountId: ACCOUNT, amount: "0", requestKey: KEY }))).status).toBe("error");
    expect(await removeExternalLoss(idleState, form({ entryId: LOSS, reason: "Typed twice" }))).toMatchObject({ status: "success" });
    expect(db.calls("remove_external_loss")[0]).toEqual({ p_entry_id: LOSS, p_reason: "Typed twice" });
    expect(m.revalidate).toHaveBeenCalledWith(`/accounts/${ACCOUNT}/manage`);
    expect(await removeExternalLoss(idleState, form({ entryId: KEY }))).toEqual({ status: "error", message: "That external loss isn't available." });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("risk policy versions (§3.10)", () => {
  const policy = { accountId: ACCOUNT, maxRiskPercent: "0.75", defaultRiskPercent: "0.5", maxDailyTrades: "3", minRR: "2.5", rrPolicy: "WARN", newsPolicy: "BLOCK", dailyLossCap: "300" };

  it("schedules a version for the next strategy day by default", async () => {
    db.results.create_risk_policy_version = () => ({ data: KEY, error: null });
    expect(await createRiskPolicyVersion(idleState, form(policy))).toEqual({
      status: "success", message: "New risk plan version starts on the next trading day (UTC−5). Today's checks keep the current version.", data: { effective: "NEXT_DAY" },
    });
    expect(db.calls("create_risk_policy_version")[0]).toEqual({
      p_account_id: ACCOUNT, p_config: { maxRiskPercent: "0.75", defaultRiskPercent: "0.5", maxDailyTrades: 3, minRR: "2.5", rrPolicy: "WARN", newsPolicy: "BLOCK", dailyLossCap: "300" },
      p_immediate: false, p_reason: null,
    });
  });

  it("requires a default within the maximum and a reason for an immediate change", async () => {
    expect(await createRiskPolicyVersion(idleState, form({ ...policy, defaultRiskPercent: "1", immediate: "on", reason: "no" }))).toEqual({
      status: "error", message: INVALID, fieldErrors: {
        defaultRiskPercent: "Default risk must be more than 0% and not above the maximum.", immediateReason: "An immediate change needs a reason of at least 5 characters.",
      },
    });
    db.results.create_risk_policy_version = () => ({ data: KEY, error: null });
    expect(await createRiskPolicyVersion(idleState, form({ ...policy, immediate: "on", reason: "Tighten after drawdown" }))).toMatchObject({ status: "success", data: { effective: "TODAY" } });
    expect(db.calls("create_risk_policy_version")[0]).toMatchObject({ p_immediate: true, p_reason: "Tighten after drawdown" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("context and display preferences (§9.2, §13.9)", () => {
  const attributes = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 34560000, secure: true };

  it("stores All Accounts or an active account of the user, never an archived or foreign one", async () => {
    m.headers.set("origin", "https://trading.example");
    expect(await setAccountContext(idleState, form({ account: "ALL" }))).toEqual({ status: "success" });
    expect(m.cookieSets).toEqual([["tos_account", "all", attributes]]);
    expect(await setAccountContext(idleState, form({ account: ACCOUNT }))).toEqual({ status: "success" });
    expect(m.cookieSets.slice(1)).toEqual([["tos_last_account", ACCOUNT, attributes], ["tos_account", ACCOUNT, attributes]]);
    expect(m.revalidate).toHaveBeenCalledWith("/", "layout");
    expect(await setAccountContext(idleState, form({ account: ARCHIVED }))).toEqual({ status: "error", message: "That trading account isn't available." });
    expect(await setAccountContext(idleState, form({ account: "20000000-0000-4000-8000-0000000000ff" }))).toEqual({ status: "error", message: "That trading account isn't available." });
    expect(await setAccountContext(idleState, form({ account: "first" }))).toEqual({ status: "error", message: "Choose All Accounts or one of your trading accounts." });
    expect(m.cookieSets).toHaveLength(3);
  });

  it("stores theme, time display (local needs the browser zone) and developer mode", async () => {
    expect(await setTheme(idleState, form({ theme: "dark" }))).toEqual({ status: "success" });
    expect(await setTheme(idleState, form({ theme: "neon" }))).toEqual({ status: "error", message: "Choose light, dark or system." });
    expect(await setTimeDisplay(idleState, form({ mode: "local" }))).toEqual({ status: "error", message: "Your browser's time zone could not be read. Choose strategy time or UTC." });
    expect(await setTimeDisplay(idleState, form({ mode: "local", zone: "Europe/Berlin" }))).toEqual({ status: "success" });
    expect(m.jar.get("tos_time")).toBe("local");
    expect(m.jar.get("tos_tz")).toBe("Europe/Berlin");
    expect(await setTimeDisplay(idleState, form({ mode: "utc" }))).toEqual({ status: "success" });
    expect(m.jar.has("tos_tz")).toBe(false);
    expect(await setDeveloperMode(idleState, form({ enabled: "on" }))).toEqual({ status: "success", message: "Technical details open by default." });
    expect(m.jar.get("tos_dev")).toBe("1");
    expect(await setDeveloperMode(idleState, form({}))).toMatchObject({ status: "success" });
    expect(m.jar.has("tos_dev")).toBe(false);
    expect(m.jar.get("tos_theme")).toBe("dark");
  });

  it("signs out through the V1 sign-out (cookies, redirect)", async () => {
    await signOut(idleState, form({}));
    expect(m.logout).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("change password (§14.11): re-authentication with a non-persisting client", () => {
  function verifier(signIn: unknown, update: unknown = { data: {}, error: null }) {
    const client = {
      auth: {
        signInWithPassword: vi.fn(async () => signIn),
        updateUser: vi.fn(async () => update),
        signOut: vi.fn(async () => ({ error: null })),
      },
    };
    m.createClient.mockReturnValue(client);
    return client;
  }
  const valid = { currentPassword: "old-password", newPassword: "new-password-123", confirmation: "new-password-123" };

  const fresh = { access_token: "fresh-access-token", refresh_token: "fresh-refresh-token" };

  it("verifies the current password for the session user, sets the new one on that fresh session, which this browser adopts, and signs out other devices", async () => {
    const client = verifier({ data: { user: { id: USER }, session: { ...fresh, expires_in: 3600 } }, error: null });
    expect(await changePassword(idleState, form(valid))).toEqual({ status: "success", message: "Password changed. Other devices were signed out." });
    expect(m.createClient).toHaveBeenCalledWith("https://project.supabase.co", "sb_publishable_test", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({ email: "trader@example.test", password: "old-password" });
    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: "new-password-123" });
    // The auth server ends every session except the one that changed the password: the browser continues on it.
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(m.browser.auth.setSession).toHaveBeenCalledWith(fresh);
    expect(m.browser.auth.signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(m.browser.auth.setSession.mock.invocationCallOrder[0]).toBeLessThan(m.browser.auth.signOut.mock.invocationCallOrder[0]);
    expect(db.auth.signOut).not.toHaveBeenCalled();
  });

  it("asks to sign in again when this browser cannot adopt the fresh session, and ends that session", async () => {
    const client = verifier({ data: { user: { id: USER }, session: fresh }, error: null });
    m.browser.auth.setSession.mockResolvedValueOnce({ data: null, error: new Error("invalid session") });
    expect(await changePassword(idleState, form(valid))).toEqual({ status: "success", message: "Password changed. Sign in again with your new password." });
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(m.browser.auth.signOut).not.toHaveBeenCalled();
  });

  it("still reports the change when other sessions cannot be signed out", async () => {
    verifier({ data: { user: { id: USER }, session: fresh }, error: null });
    m.browser.auth.signOut.mockResolvedValueOnce({ error: new Error("upstream") });
    expect(await changePassword(idleState, form(valid))).toEqual({ status: "success", message: "Password changed. Sign out on your other devices to apply it there." });
  });

  it.each([
    ["a wrong current password", { data: { user: null }, error: { name: "AuthApiError", status: 400, message: "Invalid login credentials" } }],
    ["another user's password", { data: { user: { id: "10000000-0000-4000-8000-0000000000ff" } }, error: null }],
  ])("refuses %s without changing anything", async (_label, signIn) => {
    const client = verifier(signIn);
    expect(await changePassword(idleState, form(valid))).toEqual({
      status: "error", message: "Your current password is incorrect.", fieldErrors: { currentPassword: "Your current password is incorrect." },
    });
    expect(client.auth.updateUser).not.toHaveBeenCalled();
    expect(m.browser.auth.setSession).not.toHaveBeenCalled();
    expect(db.auth.signOut).not.toHaveBeenCalled();
  });

  it("reports an auth outage and maps password policy errors", async () => {
    verifier({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 503, message: "upstream" } });
    expect(await changePassword(idleState, form(valid))).toEqual({ status: "error", message: "The sign-in service is temporarily unavailable. Nothing was changed. Please try again." });
    expect(m.log).toHaveBeenCalledWith("auth_unavailable", 503);
    verifier({ data: { user: { id: USER } }, error: null }, { data: null, error: { code: "weak_password", status: 422, message: "weak" } });
    expect(await changePassword(idleState, form(valid))).toMatchObject({ status: "error", fieldErrors: { newPassword: "Choose a stronger password that meets your account's password policy." } });
  });

  it("validates the form before contacting the auth service", async () => {
    verifier({ data: { user: { id: USER } }, error: null });
    expect(await changePassword(idleState, form({ currentPassword: "", newPassword: "short", confirmation: "other" }))).toEqual({
      status: "error", message: "Check the highlighted fields.", fieldErrors: { currentPassword: "Enter your current password.", newPassword: "Use a new password between 8 and 256 characters." },
    });
    expect(await changePassword(idleState, form({ currentPassword: "same-password", newPassword: "same-password", confirmation: "same-password" }))).toMatchObject({
      fieldErrors: { newPassword: "Choose a password different from your current password." },
    });
    expect(await changePassword(idleState, form({ ...valid, confirmation: "mismatch-123" }))).toMatchObject({ fieldErrors: { confirmation: "The new passwords do not match." } });
    expect(m.createClient).not.toHaveBeenCalled();
  });
});
