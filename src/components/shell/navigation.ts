import type { AccountContextSelection, ShellAccount } from "./types";

/** Primary navigation (§1.1). Icons are attached by the client components that render it. */

export type NavKey = "today" | "journal" | "accounts" | "edge" | "review" | "settings";

export type NavItem = { key: NavKey; label: string; href: string };

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "today", label: "Today", href: "/today" },
  { key: "journal", label: "Journal", href: "/journal" },
  { key: "accounts", label: "Accounts", href: "/accounts" },
  { key: "edge", label: "EDGE", href: "/edge" },
  { key: "review", label: "Review", href: "/review" },
  { key: "settings", label: "Settings", href: "/settings" },
];

export const PLAN_TRADE_HREF = "/trades/new";
export const LIVE_TRADE_HREF = "/trades/live/new";

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export type NewTradeAction = "plan" | "live";

/**
 * The global primary action a page belongs to (§1.1, §13.3): Plan Trade (`/trades/new`) and Record Live Trade
 * (`/trades/live/new`) are the header's two actions (the `+` tab on phones), not a section of the navigation.
 */
export function newTradeAction(pathname: string | null | undefined): NewTradeAction | null {
  if (pathname === PLAN_TRADE_HREF) return "plan";
  if (pathname === LIVE_TRADE_HREF) return "live";
  return null;
}

/**
 * The navigation section a path belongs to. Trades (their workspace and Edit Draft) live under Journal; the new-trade
 * forms belong to no section, because the header's primary action that opened them is marked instead.
 */
export function activeNavKey(pathname: string | null | undefined): NavKey | null {
  if (!pathname || newTradeAction(pathname) !== null) return null;
  if (matches(pathname, "/trades")) return "journal";
  return NAV_ITEMS.find((item) => matches(pathname, item.href))?.key ?? null;
}

const ACCOUNT_TYPE_LABELS = {
  DEMO: "Demo",
  EVALUATION: "Evaluation",
  FUNDED: "Funded",
  PERSONAL: "Personal",
  OTHER: "Other",
} as const;

export function accountTypeLabel(type: keyof typeof ACCOUNT_TYPE_LABELS) {
  return ACCOUNT_TYPE_LABELS[type];
}

/** URL of the current page with the account context parameter set (other parameters kept). */
export function withAccountParam(href: string, value: string) {
  const url = new URL(href, "http://context.invalid");
  url.searchParams.set("account", value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export const ALL_ACCOUNTS_LABEL = "All Accounts";

/** Label of the current context: "All Accounts" or the account name (never an id). */
export function contextLabel(accounts: readonly ShellAccount[], context: AccountContextSelection) {
  if (context.mode === "all") return ALL_ACCOUNTS_LABEL;
  return accounts.find((account) => account.id === context.accountId)?.name ?? ALL_ACCOUNTS_LABEL;
}
