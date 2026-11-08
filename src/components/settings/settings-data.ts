import "server-only";
import { aiSystemAvailability, loadAiBudget } from "@/lib/ai-budget";
import { type ContextAccount, currentSession, type Db, type DisplayPreferences, getAccountContext, getPreferences } from "@/lib/account-context";
import { EXPORT_TABLES } from "@/lib/export";
import { operationalFailure } from "@/lib/operational-log";
import { getSchemaStatus } from "@/lib/schema-gate";
import {
  type AccountConnectionState, accountConnectionStates, isMockSyncEnabled, listConnections, type PlatformConnection, type PlatformOption,
  platformOptions,
} from "@/lib/sync-service";
import type { AiBudgetModel } from "../ai/ai-budget-summary";
import type { ExportTableNames } from "./export-archive";
import type { ConnectionSnapshot, ScreenshotCounts, SettingsAccount } from "./settings-model";

/**
 * Everything Settings shows (docs/V2_ARCHITECTURE.md §14.11), read with the signed-in user's session. Each section
 * degrades on its own: an unavailable AI budget, connection list or screenshot count is reported in that section
 * and never fails the page.
 */

export interface SettingsAiAccount {
  account: SettingsAccount;
  budget: AiBudgetModel;
}

export interface SettingsConnectionRow {
  account: SettingsAccount;
  snapshot: ConnectionSnapshot;
}

export interface SettingsMockRow extends SettingsConnectionRow {
  /** The account's active mock connection. */
  mockConnectionId: string | null;
  /** Another provider's connection is active, so no mock can be added next to it. */
  otherConnection: boolean;
}

export interface SettingsPageData {
  user: { id: string; email: string };
  preferences: DisplayPreferences;
  /** Server time of this render (ISO). */
  nowIso: string;
  /** Account in the header context, listed first (the AI fix route opens Settings with `?account=`). */
  selectedAccountId: string | null;
  active: SettingsAccount[];
  archived: SettingsAccount[];
  ai: {
    /** Null when the deployment can run AI; otherwise why it can't, in words. */
    unavailableReason: string | null;
    /** Every account (active and archived), stored order. */
    accounts: SettingsAiAccount[];
  };
  /** Active accounts; `error` when the connection list could not be read. */
  connections: { rows: SettingsConnectionRow[]; error: string | null };
  /** Future platforms (never the developer mock). */
  platforms: PlatformOption[];
  /** Present only when the deployment enables the developer mock sync. */
  mockSync: { rows: SettingsMockRow[]; error: string | null } | null;
  export: { tables: ExportTableNames; screenshots: ScreenshotCounts | null };
  schemaVersion: string | null;
}

export const AI_UNAVAILABLE_COPY = "No AI request can run, and AI can't be turned on for an account. Monthly limits can still be set.";
export const CONNECTIONS_UNAVAILABLE = "Connection status is unavailable right now. Trades you record manually are not affected.";

const MANUAL_STATE: AccountConnectionState = Object.freeze({ mode: "MANUAL", connection: null, lastSyncedAt: null, message: null });

function settingsAccount(account: ContextAccount): SettingsAccount {
  return { id: account.id, name: account.name, currency: account.currency, type: account.type, status: account.status };
}

export function connectionSnapshot(state: AccountConnectionState): ConnectionSnapshot {
  const connection = state.connection;
  return {
    mode: state.mode,
    connection: connection === null ? null : {
      provider: connection.provider,
      label: connection.label,
      accountRef: connection.externalAccountRef,
      executionCount: connection.executionCount,
      unmatchedCount: connection.unmatchedCount,
      warningCount: connection.warningCount,
    },
    lastSyncedAt: state.lastSyncedAt,
    message: state.message,
  };
}

/** Table names per JSON part, in export order (the export route's own table list). */
export function exportTableNames(): ExportTableNames {
  return {
    core: EXPORT_TABLES.core.map(table => table.name),
    trades: EXPORT_TABLES.trades.map(table => table.name),
    ai: EXPORT_TABLES.ai.map(table => table.name),
    "evidence-manifest": EXPORT_TABLES["evidence-manifest"].map(table => table.name),
  };
}

async function countRows(db: Db, table: string): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error || typeof count !== "number") throw new Error("Count unavailable");
  return count;
}

/** Screenshots in the export (V2 evidence and legacy screenshots, removed ones included); null when unknown. */
async function screenshotCounts(db: Db): Promise<ScreenshotCounts | null> {
  try {
    const [evidence, legacy, evidenceRemoved, legacyRemoved] = await Promise.all([
      countRows(db, "trade_evidence"), countRows(db, "setup_screenshots"), countRows(db, "trade_evidence_removals"), countRows(db, "setup_screenshot_removals"),
    ]);
    return { total: evidence + legacy, removed: evidenceRemoved + legacyRemoved };
  } catch {
    operationalFailure("data_read_failed");
    return null;
  }
}

async function readConnections(db: Db, accounts: readonly ContextAccount[]): Promise<PlatformConnection[] | null> {
  if (accounts.length === 0) return [];
  try {
    return await listConnections(db);
  } catch {
    operationalFailure("data_read_failed");
    return null;
  }
}

function mockRows(accounts: readonly ContextAccount[], connections: readonly PlatformConnection[], states: ReadonlyMap<string, AccountConnectionState>): SettingsMockRow[] {
  return accounts.map(account => {
    const open = connections.filter(connection => connection.accountId === account.id && connection.status !== "DISCONNECTED");
    const mock = open.find(connection => connection.provider === "MOCK") ?? null;
    return {
      account: settingsAccount(account),
      snapshot: connectionSnapshot(states.get(account.id) ?? MANUAL_STATE),
      mockConnectionId: mock?.id ?? null,
      otherConnection: mock === null && open.length > 0,
    };
  });
}

export async function loadSettingsPage(): Promise<SettingsPageData> {
  const [{ db, user }, context, preferences, schema] = await Promise.all([currentSession(), getAccountContext(), getPreferences(), getSchemaStatus()]);
  const system = aiSystemAvailability();
  const [budgets, connections, screenshots] = await Promise.all([
    Promise.all(context.accounts.map(async (account): Promise<SettingsAiAccount> => ({ account: settingsAccount(account), budget: await loadAiBudget(account.id) }))),
    readConnections(db, context.accounts),
    screenshotCounts(db),
  ]);
  const states = connections === null ? null : accountConnectionStates(context.accounts.map(account => account.id), connections);
  const error = connections === null ? CONNECTIONS_UNAVAILABLE : null;
  const connectionRows = states === null ? [] : context.active.map(account => ({
    account: settingsAccount(account),
    snapshot: connectionSnapshot(states.get(account.id) ?? MANUAL_STATE),
  }));

  return {
    user: { id: user.id, email: user.email ?? "" },
    preferences,
    nowIso: new Date().toISOString(),
    selectedAccountId: context.selected.mode === "account" ? context.selected.account.id : null,
    active: context.active.map(settingsAccount),
    archived: context.archived.map(settingsAccount),
    ai: { unavailableReason: system.status === "ENABLED" ? null : AI_UNAVAILABLE_COPY, accounts: budgets },
    connections: { rows: connectionRows, error },
    platforms: platformOptions().filter(option => option.provider !== "MOCK"),
    mockSync: isMockSyncEnabled() ? { rows: connections === null || states === null ? [] : mockRows(context.active, connections, states), error } : null,
    export: { tables: exportTableNames(), screenshots },
    schemaVersion: schema.version,
  };
}
