import { ACCOUNT_TYPE_LABELS, type AccountType } from "@/domain/account-metrics";
import { formatDateTime, type Instant, type TimeDisplay, zoneLabel } from "@/domain/time-display";
import type { StatusTone } from "../ui/badge";

/**
 * Settings (docs/V2_ARCHITECTURE.md §14.11): pure view models shared by the server page and its client parts. Nothing
 * here imports server code, so client components may use it. Backend states arrive as typed values and leave as
 * words; no enum spelling reaches the default UI (§0.9, §15).
 */

export type SettingsSectionId = "general" | "ai" | "connections" | "data" | "security" | "danger" | "developer";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
}

/** Page order; each id is the anchor of its section (`/settings#ai` is the AI fix route, §11.2). */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  { id: "general", label: "General" },
  { id: "ai", label: "AI" },
  { id: "connections", label: "Connections" },
  { id: "data", label: "Data" },
  { id: "security", label: "Security" },
  { id: "danger", label: "Danger zone" },
  { id: "developer", label: "Developer" },
]);

/** A trading account as Settings lists it (latest profile revision). */
export interface SettingsAccount {
  id: string;
  name: string;
  currency: string;
  type: AccountType;
  status: "ACTIVE" | "ARCHIVED";
}

/** "Evaluation · USD" */
export function accountMeta(account: Pick<SettingsAccount, "type" | "currency">): string {
  return `${ACCOUNT_TYPE_LABELS[account.type]} · ${account.currency}`;
}

/**
 * Accounts in the order Settings shows them: the account selected in the header first (the AI fix route opens
 * Settings with `?account=`), then the rest in their stored order.
 */
export function orderAccounts<T extends { id: string }>(accounts: readonly T[], selectedId: string | null): T[] {
  const selected = accounts.find(account => account.id === selectedId);
  return selected ? [selected, ...accounts.filter(account => account !== selected)] : [...accounts];
}

// ---------------------------------------------------------------------------------------------------------
// Connections (§8.6): honest states only. Without a connection an account is Manual; nothing claims a sync that
// did not happen.
// ---------------------------------------------------------------------------------------------------------

export type ConnectionMode = "MANUAL" | "PENDING" | "CONNECTED" | "SYNCING" | "SYNCED" | "ERROR";
export type ConnectionProvider = "CTRADER" | "MT5" | "MOCK";

export const PROVIDER_LABELS: Readonly<Record<ConnectionProvider, string>> = Object.freeze({
  CTRADER: "cTrader",
  MT5: "MetaTrader 5",
  MOCK: "Mock platform",
});

export interface ConnectionSnapshot {
  mode: ConnectionMode;
  /** Present while a (not disconnected) connection exists. */
  connection: {
    provider: ConnectionProvider;
    /** The trader's own label for the connection. */
    label: string;
    /** Masked platform account reference for display (never a secret). */
    accountRef: string | null;
    executionCount: number;
    unmatchedCount: number;
    warningCount: number;
  } | null;
  lastSyncedAt: string | null;
  /** Human error message (stored without secrets) while mode is ERROR. */
  message: string | null;
}

export interface ConnectionView {
  /** Pill text: Manual · Connected · Syncing · Synced · Sync failed. */
  label: string;
  tone: StatusTone;
  /** One line under the account: the last sync or the error; null for manual accounts (the pill says it all). */
  detail: string | null;
  /** "Mock platform · Sample feed · ••••1234"; null for manual accounts. */
  source: string | null;
  /** Follow-ups worth the trader's attention, in words ("2 executions need a trade"). */
  attention: string[];
}

function syncedLine(at: Instant | null, display: TimeDisplay): string {
  if (at === null) return "Not synced yet.";
  try {
    return `Last synced ${formatDateTime(at, display)} ${zoneLabel(display, at)}.`;
  } catch {
    return "Last synced earlier.";
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The words and tone of one account's connection state (spec §8.6: Connected / Syncing / Last synced / Error / Manual). */
export function connectionView(snapshot: ConnectionSnapshot, display: TimeDisplay): ConnectionView {
  const { connection } = snapshot;
  if (snapshot.mode === "MANUAL" || connection === null) {
    return { label: "Manual", tone: "neutral", detail: null, source: null, attention: [] };
  }
  const source = [PROVIDER_LABELS[connection.provider], connection.label, connection.accountRef].filter((part): part is string => Boolean(part)).join(" · ");
  const attention: string[] = [];
  if (connection.unmatchedCount > 0) attention.push(`${plural(connection.unmatchedCount, "platform execution needs", "platform executions need")} a trade.`);
  if (connection.warningCount > 0) attention.push(`${plural(connection.warningCount, "platform change was", "platform changes were")} not applied.`);
  switch (snapshot.mode) {
    case "SYNCING":
      return { label: "Syncing", tone: "info", detail: "Reading positions from the platform…", source, attention };
    case "SYNCED":
      return { label: "Synced", tone: "positive", detail: syncedLine(snapshot.lastSyncedAt, display), source, attention };
    case "ERROR":
      return {
        label: "Sync failed",
        tone: "negative",
        detail: snapshot.message?.trim() ? snapshot.message.trim() : "The last sync did not finish. Imported trades are kept.",
        source,
        attention,
      };
    default:
      return { label: "Connected", tone: "info", detail: syncedLine(snapshot.lastSyncedAt, display), source, attention };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Data export (§10.5)
// ---------------------------------------------------------------------------------------------------------

/** Screenshot counts shown next to "Include screenshots"; removed screenshots are part of the export too. */
export interface ScreenshotCounts {
  total: number;
  removed: number;
}

export function screenshotSummary(counts: ScreenshotCounts | null): string {
  if (counts === null) return "Every screenshot is checked against the fingerprint recorded when it was saved.";
  if (counts.total === 0) return "You have no screenshots yet.";
  const removed = counts.removed > 0 ? `, including ${counts.removed} removed from ${counts.removed === 1 ? "its trade" : "their trades"}` : "";
  return `${plural(counts.total, "screenshot", "screenshots")}${removed}. Each is checked against the fingerprint recorded when it was saved.`;
}

// ---------------------------------------------------------------------------------------------------------
// Danger zone (§10.4): exactly what is deleted.
// ---------------------------------------------------------------------------------------------------------

export const DELETED_DATA: readonly string[] = Object.freeze([
  "Trading accounts, account values, risk plans and instruments",
  "Trades, drafts, plans, fills and results",
  "Journal entries, screenshots, tags and reviews",
  "AI history and usage records",
  "Settings and preferences",
  "Your login: email and password",
]);

/** The word typed to confirm (must match DELETE_CONFIRMATION_WORD in src/lib/erasure.ts, which is server-only). */
export const DELETE_WORD = "DELETE";
