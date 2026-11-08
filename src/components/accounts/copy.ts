import { ACCOUNT_TYPE_LABELS, type AccountPlatform, type AccountStatus, type AccountType, PLATFORM_LABELS } from "@/domain/account-metrics";

/**
 * Copy and choice lists of the Accounts screens (docs/V2_ARCHITECTURE.md §8.4, §9, §14.7–14.9, §15). Pure data, safe
 * for server and client components. Exact strings the spec fixes are exported so tests can pin them.
 */

export const ARCHIVE_COPY = "Archiving hides the account from new trades; history stays.";
export const RESTORE_COPY = "Restoring makes the account available for new trades again. Its history is unchanged.";
export const EXTERNAL_LOSSES_TITLE = "External realized losses today";
export const ADD_EXTERNAL_LOSS = "Add external loss";
export const EXTERNAL_LOSS_HELPER = "Losses from trades not recorded in Trading OS today, for example on another platform.";
/**
 * Synced platform positions count only once their close is recorded on a trade (V2_1_GAPS.md §1.2): until then the
 * Connection tab sends their loss here, and the trader removes it once the close is recorded.
 */
export const EXTERNAL_LOSS_SYNC_NOTE =
  "Don't add losses already recorded on a trade in Trading OS (imported trades included): they are counted. A synced platform position counts only once its close is recorded on a trade.";
/** The Connection tab's pointer to External losses for a closed position that is not on a trade yet. */
export const UNMATCHED_LOSS_REMOVE_NOTE = "If you later record its close on a trade, remove that external loss.";
export const UPDATE_VALUES = "Update account values";
export const CONFIRM_UNCHANGED = "Confirm unchanged";
export const STARTS_TOMORROW = "Starts tomorrow";
export const VERSIONING_COPY =
  "Risk plans are versioned. A new version applies from the next trading day (00:00 UTC−5); every plan, check and trade keeps the version it was evaluated with, so history is never rewritten.";
export const IMMEDIATE_COPY = "An immediate change applies to checks from now on and records your reason. Use it to tighten limits during the day.";
/** The "Immediately" timing option: the version stays in effect until a newer one, it is not a one-day override. */
export const IMMEDIATE_OPTION_COPY = "Applies from now on, today included, until you create another version. Requires a reason.";
export const NEXT_DAY_OPTION_COPY = "From 00:00 UTC−5. Today's checks keep the current version.";
export const ARCHIVED_VALUES_COPY = "Archived accounts don't need daily values. Restore the account to record values.";
export const ARCHIVED_DASHBOARD_COPY =
  "It takes no new trades. Its history stays readable here, on each trade, and in the Journal and EDGE of All Accounts, filtered to this account. Restore it to trade on it again.";
export const R_UNITS_NOTE = "R is per-trade risk units, not money.";
export const MANUAL_CONNECTION_COPY = "Trades are recorded by you in Trading OS. No trading platform is contacted.";

/** Tick value is denominated in the account currency (spec §3.2); the form says so. */
export function tickValueNote(currency: string): string {
  return `Tick value is the money value of one tick for one unit of size, in ${currency} (this account's currency).`;
}

/** Account currencies the database accepts (migration 0015 allow-list), with names for the picker. */
export const ACCOUNT_CURRENCIES: readonly { code: string; name: string }[] = Object.freeze([
  { code: "USD", name: "US dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British pound" },
  { code: "CHF", name: "Swiss franc" },
  { code: "JPY", name: "Japanese yen" },
  { code: "AUD", name: "Australian dollar" },
  { code: "CAD", name: "Canadian dollar" },
  { code: "NZD", name: "New Zealand dollar" },
  { code: "SGD", name: "Singapore dollar" },
  { code: "HKD", name: "Hong Kong dollar" },
  { code: "SEK", name: "Swedish krona" },
  { code: "NOK", name: "Norwegian krone" },
  { code: "DKK", name: "Danish krone" },
  { code: "PLN", name: "Polish złoty" },
  { code: "CZK", name: "Czech koruna" },
  { code: "HUF", name: "Hungarian forint" },
  { code: "ZAR", name: "South African rand" },
  { code: "MXN", name: "Mexican peso" },
]);

export const ACCOUNT_TYPES: readonly AccountType[] = Object.freeze(["EVALUATION", "FUNDED", "PERSONAL", "DEMO", "OTHER"]);
export const ACCOUNT_TYPE_HINTS: Readonly<Record<AccountType, string>> = Object.freeze({
  EVALUATION: "Prop-firm challenge or verification",
  FUNDED: "Prop-firm funded account",
  PERSONAL: "Your own capital at a broker",
  DEMO: "Practice account with simulated money",
  OTHER: "Any other account",
});

export const PLATFORMS: readonly AccountPlatform[] = Object.freeze(["MANUAL", "CTRADER", "MT5", "MT4", "TRADINGVIEW", "OTHER"]);
export const PLATFORM_HINT = "Where you place the trades. In this version every trade is recorded manually; no platform is connected.";

export function accountTypeLabel(type: AccountType): string {
  return ACCOUNT_TYPE_LABELS[type];
}

export function platformLabel(platform: AccountPlatform): string {
  return PLATFORM_LABELS[platform];
}

/** "Evaluation · FTMO", or the type alone without a broker. */
export function typeAndBroker(type: AccountType, broker: string | null): string {
  return broker ? `${ACCOUNT_TYPE_LABELS[type]} · ${broker}` : ACCOUNT_TYPE_LABELS[type];
}

/** Words for the stored risk-plan policies. */
export const RR_POLICY_LABELS = Object.freeze({ BLOCK: "Blocks below the minimum", WARN: "Warns below the minimum" });

/** Manage tabs (`?tab=`); the command palette links to `account-values` and `external-losses`. */
export const MANAGE_TABS = [
  { key: "profile", label: "Profile" },
  { key: "account-values", label: "Account values" },
  { key: "external-losses", label: "External losses" },
  { key: "risk-policy", label: "Risk policy" },
  { key: "instruments", label: "Instruments" },
  { key: "connection", label: "Connection" },
] as const;
export type ManageTab = (typeof MANAGE_TABS)[number]["key"];

export function parseManageTab(value: string | string[] | undefined): ManageTab {
  const text = Array.isArray(value) ? value[0] : value;
  return MANAGE_TABS.find(tab => tab.key === text)?.key ?? "profile";
}

/** Id of the "Active accounts" heading of /accounts: where focus goes after an account moves between the groups. */
export const ACTIVE_ACCOUNTS_HEADING = "accounts-active";

export function manageHref(accountId: string, tab: ManageTab = "profile"): string {
  return tab === "profile" ? `/accounts/${accountId}/manage` : `/accounts/${accountId}/manage?tab=${tab}`;
}

/**
 * An account's dashboard. Opening an active account's dashboard makes it the trading-account context (`?account=`,
 * §9.2), so the header and its Plan Trade / Record Live Trade name the account on screen (master spec 60.11). An
 * archived account can never be the context: its link leaves the context as it is. Context links are never
 * prefetched (`prefetchFor`).
 */
export function accountDashboardHref(account: { id: string; status: AccountStatus }): string {
  return account.status === "ACTIVE" ? `/accounts/${account.id}?account=${account.id}` : `/accounts/${account.id}`;
}

/** Plan Trade and Record Live Trade on this account, whatever the context (they also switch it, §9.2). */
export function planTradeHref(accountId: string): string {
  return `/trades/new?account=${accountId}`;
}

export function recordLiveTradeHref(accountId: string): string {
  return `/trades/live/new?account=${accountId}`;
}
