import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";
import type { AccountPlatform, AccountStatus, AccountType } from "@/domain/account-metrics";
import { stripZeros } from "@/domain/format";
import { resolveTimeDisplay, type TimeDisplay } from "@/domain/time-display";
import { requireUser } from "./supabase/server";

/**
 * Trading-account context (docs/V2_ARCHITECTURE.md §9.1–9.2). All Accounts is an aggregation context, never a record:
 * no row, id or placeholder account represents it. The selection lives in the `tos_account` cookie (`all` or an
 * account id); `?account=` on a page request overrides it, and the proxy (src/proxy.ts) validates that value, mirrors
 * it into this request's cookies and stores it. An unknown, foreign or archived id resolves to All Accounts with the
 * ACCOUNT_UNAVAILABLE notice, never silently to "the first account".
 */

export const ACCOUNT_COOKIE = "tos_account";
/** Most recently used active account; the default of Plan Trade / Record Live Trade in All Accounts. */
export const LAST_ACCOUNT_COOKIE = "tos_last_account";
/** Set by the proxy on the forwarded request (never stored) when `?account=` named an unavailable account. */
export const ACCOUNT_NOTICE_HEADER = "x-tos-account-notice";
export const ALL_ACCOUNTS_VALUE = "all";
/** 400 days, the longest lifetime browsers accept. */
export const CONTEXT_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
export const ACCOUNT_UNAVAILABLE = "ACCOUNT_UNAVAILABLE";
export const ACCOUNT_UNAVAILABLE_NOTICE = "That trading account isn't available. Showing All Accounts.";

export type Db = SupabaseClient;
export interface Session {
  db: Db;
  user: User;
}

/** The verified user and an RLS-scoped client, once per request (React cache). Redirects to sign-in without a session. */
export const currentSession = cache(async (): Promise<Session> => {
  const { db, user } = await requireUser();
  return { db, user };
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `all` or a lowercase account id; anything else is not a context value. */
export function parseAccountValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === ALL_ACCOUNTS_VALUE) return ALL_ACCOUNTS_VALUE;
  return UUID.test(text) ? text : null;
}

/** A trading account as every V2 screen sees it: the account plus its latest profile revision. */
export interface ContextAccount {
  id: string;
  /** Display name of the latest profile (the account's original name when it has no profile). */
  name: string;
  currency: string;
  type: AccountType;
  platform: AccountPlatform;
  broker: string | null;
  status: AccountStatus;
  /** Canonical decimal from the latest profile; null when unknown or when the account has no profile yet. */
  startingBalance: string | null;
  createdAt: string;
  /**
   * PROFILE: the latest `account_profiles` revision. DEFAULT: the account has no profile (created by
   * bootstrap_demo_account after migration 0015) and shows the implicit defaults: its name, Manual, Demo, Active.
   */
  profile: "PROFILE" | "DEFAULT";
}

export type AccountSelection = { mode: "all" } | { mode: "account"; account: ContextAccount };

export interface AccountContext {
  /** Every account of the user, oldest first. */
  accounts: ContextAccount[];
  active: ContextAccount[];
  archived: ContextAccount[];
  selected: AccountSelection;
  notice: typeof ACCOUNT_UNAVAILABLE | null;
  /** Human copy of `notice` for the shell. */
  noticeText: string | null;
  /** Accounts the current context covers: the selected account, or every account (archived ones keep their history). */
  scopeAccountIds: string[];
  /**
   * Explicit account preselected by Plan Trade / Record Live Trade: the selected account; in All Accounts the most
   * recently used active account (`tos_last_account`), else the only active account; null when the user must choose.
   */
  formDefaultAccountId: string | null;
}

const ACCOUNT_TYPES = ["DEMO", "EVALUATION", "FUNDED", "PERSONAL", "OTHER"] as const;
const PLATFORMS = ["MANUAL", "CTRADER", "MT5", "MT4", "TRADINGVIEW", "OTHER"] as const;
const STATUSES = ["ACTIVE", "ARCHIVED"] as const;
const decimalText = z.string().regex(/^\d+(\.\d+)?$/);

const accountRow = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  created_at: z.string(),
});
const profileRow = z.object({
  id: z.number().int(),
  account_id: z.uuid(),
  display_name: z.string().min(1),
  broker: z.string().nullable(),
  platform: z.enum(PLATFORMS),
  account_type: z.enum(ACCOUNT_TYPES),
  starting_balance: decimalText.nullable(),
  status: z.enum(STATUSES),
});

export const ACCOUNT_SELECT = "id,name,currency,created_at";
export const PROFILE_SELECT = "id,account_id,display_name,broker,platform,account_type,starting_balance::text,status";

/** Account plus the latest of its profile rows (any order); the implicit defaults when it has none. */
export function contextAccount(account: z.infer<typeof accountRow>, profiles: readonly z.infer<typeof profileRow>[]): ContextAccount {
  const latest = profiles.filter(profile => profile.account_id === account.id).reduce<z.infer<typeof profileRow> | null>(
    (best, profile) => (best === null || profile.id > best.id ? profile : best),
    null,
  );
  if (latest === null) {
    return {
      id: account.id, name: account.name, currency: account.currency, type: "DEMO", platform: "MANUAL", broker: null, status: "ACTIVE",
      startingBalance: null, createdAt: account.created_at, profile: "DEFAULT",
    };
  }
  return {
    id: account.id, name: latest.display_name, currency: account.currency, type: latest.account_type, platform: latest.platform,
    broker: latest.broker, status: latest.status, startingBalance: latest.starting_balance === null ? null : stripZeros(latest.starting_balance),
    createdAt: account.created_at, profile: "PROFILE",
  };
}

/** The user's accounts with their latest profiles (RLS session plus an explicit owner filter). */
export async function loadAccounts(db: Db, userId: string): Promise<ContextAccount[]> {
  const [accounts, profiles] = await Promise.all([
    db.from("accounts").select(ACCOUNT_SELECT).eq("user_id", userId).order("created_at", { ascending: true }).order("id", { ascending: true }),
    db.from("account_profiles").select(PROFILE_SELECT).eq("user_id", userId).order("id", { ascending: false }),
  ]);
  if (accounts.error || profiles.error) throw new Error("Trading accounts are unavailable.");
  const profileRows = z.array(profileRow).parse(profiles.data ?? []);
  return z.array(accountRow).parse(accounts.data ?? []).map(account => contextAccount(account, profileRows));
}

/** One of the user's accounts with its latest profile, or null when it is not theirs (or does not exist). */
export async function loadAccount(db: Db, userId: string, accountId: string): Promise<ContextAccount | null> {
  if (!UUID.test(accountId)) return null;
  const [account, profiles] = await Promise.all([
    db.from("accounts").select(ACCOUNT_SELECT).eq("id", accountId).eq("user_id", userId).maybeSingle(),
    db.from("account_profiles").select(PROFILE_SELECT).eq("account_id", accountId).eq("user_id", userId).order("id", { ascending: false }).limit(1),
  ]);
  if (account.error || profiles.error) throw new Error("Trading accounts are unavailable.");
  if (!account.data) return null;
  return contextAccount(accountRow.parse(account.data), z.array(profileRow).parse(profiles.data ?? []));
}

export interface ContextInput {
  accounts: readonly ContextAccount[];
  /** Effective context value of this request: the stored cookie, or the `?account=` override the proxy mirrored. */
  stored: string | null | undefined;
  lastAccount: string | null | undefined;
  /** The proxy rejected this request's `?account=` value. */
  proxyNotice: boolean;
}

/** Pure resolution of §9.2; never returns a placeholder account. */
export function resolveAccountContext(input: ContextInput): AccountContext {
  const accounts = [...input.accounts];
  const active = accounts.filter(account => account.status === "ACTIVE");
  const archived = accounts.filter(account => account.status === "ARCHIVED");
  const value = parseAccountValue(input.stored);
  const match = value !== null && value !== ALL_ACCOUNTS_VALUE ? accounts.find(account => account.id === value) : undefined;
  const usable = match !== undefined && match.status === "ACTIVE" ? match : null;
  const unavailable = input.proxyNotice || (value !== null && value !== ALL_ACCOUNTS_VALUE && usable === null);
  const selected: AccountSelection = usable ? { mode: "account", account: usable } : { mode: "all" };
  const last = parseAccountValue(input.lastAccount);
  const lastActive = active.find(account => account.id === last);
  return {
    accounts,
    active,
    archived,
    selected,
    notice: unavailable ? ACCOUNT_UNAVAILABLE : null,
    noticeText: unavailable ? ACCOUNT_UNAVAILABLE_NOTICE : null,
    scopeAccountIds: usable ? [usable.id] : accounts.map(account => account.id),
    formDefaultAccountId: usable?.id ?? lastActive?.id ?? (active.length === 1 ? active[0].id : null),
  };
}

/** The request's account context, once per request (React cache). */
export const getAccountContext = cache(async (): Promise<AccountContext> => {
  const { db, user } = await currentSession();
  const [jar, requestHeaders, accounts] = await Promise.all([cookies(), headers(), loadAccounts(db, user.id)]);
  return resolveAccountContext({
    accounts,
    stored: jar.get(ACCOUNT_COOKIE)?.value,
    lastAccount: jar.get(LAST_ACCOUNT_COOKIE)?.value,
    proxyNotice: requestHeaders.get(ACCOUNT_NOTICE_HEADER) === ACCOUNT_UNAVAILABLE,
  });
});

/** Cookie attributes of the context cookies (§9.2): httpOnly, SameSite=Lax, whole site, 400 days. */
export function contextCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: CONTEXT_COOKIE_MAX_AGE, secure };
}

/** HTTPS requests (the browser's Origin, else the proxy's forwarded protocol) get Secure cookies. */
export function isSecureRequest(requestHeaders: Pick<Headers, "get">): boolean {
  const origin = requestHeaders.get("origin");
  if (origin) {
    try {
      return new URL(origin).protocol === "https:";
    } catch {
      return false;
    }
  }
  return requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/**
 * Stores one context or preference cookie with the §9.2 attributes. Server actions and route handlers only (cookies
 * cannot be written while a page renders).
 */
export async function setContextCookie(name: string, value: string): Promise<void> {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  jar.set(name, value, contextCookieOptions(isSecureRequest(requestHeaders)));
}

/** Removes one context or preference cookie (server actions only). */
export async function deleteContextCookie(name: string): Promise<void> {
  (await cookies()).delete(name);
}

/** The shell's selection value (the account id, or All Accounts). */
export function shellSelection(context: AccountContext): { mode: "all" } | { mode: "account"; accountId: string } {
  return context.selected.mode === "all" ? { mode: "all" } : { mode: "account", accountId: context.selected.account.id };
}

/** Accounts as the shell lists them (name, currency, status, type). */
export function shellAccounts(context: AccountContext) {
  return context.accounts.map(account => ({ id: account.id, name: account.name, currency: account.currency, status: account.status, type: account.type }));
}

/** Name and currency of each account by id (labels for rows of any account in the context). */
export function accountDirectory(accounts: readonly ContextAccount[]): ReadonlyMap<string, ContextAccount> {
  return new Map(accounts.map(account => [account.id, account] as const));
}

// ---------------------------------------------------------------------------------------------------------
// Display preferences (cookies written by src/app/actions/context.ts; spec §6.6, §13.1, §13.9).
// ---------------------------------------------------------------------------------------------------------
export const THEME_COOKIE = "tos_theme";
export const TIME_COOKIE = "tos_time";
export const TIME_ZONE_COOKIE = "tos_tz";
export const DEVELOPER_COOKIE = "tos_dev";
export const SIDEBAR_COOKIE = "tos_sidebar";

export type ThemePreference = "light" | "dark" | "system";

export interface DisplayPreferences {
  theme: ThemePreference;
  /** Strategy time (fixed UTC−5) unless the user chose UTC or local time with a valid captured zone. */
  timeDisplay: TimeDisplay;
  /** Settings → Developer: Technical details render expanded (`tos_dev=1`). */
  developerMode: boolean;
  sidebarCollapsed: boolean;
}

export function resolvePreferences(read: (name: string) => string | undefined): DisplayPreferences {
  const theme = read(THEME_COOKIE);
  return {
    theme: theme === "light" || theme === "dark" ? theme : "system",
    timeDisplay: resolveTimeDisplay(read(TIME_COOKIE), read(TIME_ZONE_COOKIE)),
    developerMode: read(DEVELOPER_COOKIE) === "1",
    sidebarCollapsed: read(SIDEBAR_COOKIE) === "collapsed",
  };
}

/** The request's display preferences, once per request. */
export const getPreferences = cache(async (): Promise<DisplayPreferences> => {
  const jar = await cookies();
  return resolvePreferences(name => jar.get(name)?.value);
});
