import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { LIFECYCLES, type Lifecycle, TRADE_ORIGINS } from "@/domain/ledger";
import type {
  Direction, ExecutionSyncProvider, ExternalPosition, IngestDecision, IngestOutcome, SyncCandidate, SyncConnection, SyncProviderId,
  SyncReport, SyncStore,
} from "@/domain/sync/contract";
import { matchExecution } from "@/domain/sync/match";
import { MockSyncProvider } from "@/domain/sync/mock-provider";
import { normalizeSymbol } from "@/domain/sync/normalize";
import { runSync } from "@/domain/sync/run-sync";
import { compareInstants, type Instant, isInstant } from "@/domain/time-display";
import { trustedServer } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";

/**
 * Server orchestration for platform connections (spec §8.6, §10.3). Reads use the trader's RLS client.
 * Ingest and sync status go through the service-role client with the user id of the verified session,
 * never a client-supplied id, and the database re-checks that this user owns the connection. V2 ships
 * only the deterministic mock provider, enabled by TRADING_OS_ENABLE_MOCK_SYNC=true.
 */

export type Db = SupabaseClient;

export const MOCK_SYNC_UNAVAILABLE = "Mock platform sync is not available in this deployment.";
export const READ_ONLY_SCOPE = "Read-only: account, positions, deals, balances. Trading OS never requests trading permission.";
export const MOCK_CONNECTION_LABEL = "Mock platform";

export function isMockSyncEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.TRADING_OS_ENABLE_MOCK_SYNC === "true";
}

export interface PlatformOption {
  provider: SyncProviderId;
  name: string;
  available: boolean;
  note: string;
}

/** Settings → Connections choices. Never claims connectivity that does not exist. */
export function platformOptions(env: Readonly<Record<string, string | undefined>> = process.env): PlatformOption[] {
  const options: PlatformOption[] = [
    { provider: "CTRADER", name: "cTrader", available: false, note: "Read-only sync planned for V2.1" },
    { provider: "MT5", name: "MetaTrader 5", available: false, note: "Bridge planned for V2.2" },
  ];
  if (isMockSyncEnabled(env)) {
    options.push({ provider: "MOCK", name: "Mock platform", available: true, note: "Developer simulation with sample positions; never contacts a real platform." });
  }
  return options;
}

// ---------------------------------------------------------------------------------------------------------
// Error contract: SQL raises 'CODE: detail'; the UI only ever sees the copy below.
// ---------------------------------------------------------------------------------------------------------
const ERROR_COPY = {
  AUTH_REQUIRED: "Your session has ended. Sign in again to continue.",
  ACCOUNT_NOT_FOUND: "That trading account isn't available.",
  // An archived account takes no new connection and no new imported trade (0015 private.require_active_account).
  ACCOUNT_ARCHIVED: "This trading account is archived, so it takes no new trades or records. Restore it in Manage account to use it again.",
  PROVIDER_NOT_AVAILABLE: "This platform isn't available yet. Trades are recorded manually in this version.",
  CONNECTION_EXISTS: "This trading account already has an active connection. Disconnect it first.",
  CONNECTION_NOT_FOUND: "That connection isn't available.",
  CONNECTION_DISCONNECTED: "This connection is disconnected. Connect it again before syncing.",
  CURRENCY_MISMATCH: "The platform reports a different currency than this trading account.",
  INVALID_TIME: "The platform reported times that are in the future or out of order.",
  TRADE_NOT_FOUND: "That trade isn't available.",
  EXECUTION_NOT_FOUND: "That platform execution isn't available.",
  LINK_MISMATCH: "The platform execution doesn't match this trade's account, instrument, direction or lock time.",
  LINK_NOT_ALLOWED: "Only planned trades with a locked plan can be linked to a platform execution.",
  TRADE_ALREADY_LINKED: "This trade is already linked to another platform execution.",
  EXECUTION_ALREADY_LINKED: "This platform execution is already linked to another trade.",
  LINK_NOT_FOUND: "This trade and platform execution are not linked.",
  LINK_NOT_REMOVABLE: "An imported trade stays linked to the platform position it was created from.",
  IDEMPOTENCY_CONFLICT: "This request was already used for a different change. Refresh and try again.",
  INVALID_INPUT: "Check the entered values and try again.",
} as const satisfies Record<string, string>;
export type ConnectionErrorCode = keyof typeof ERROR_COPY;
const DEFAULT_ERROR = "The connection change could not be saved. Refresh and try again.";

function isKnownCode(code: string): code is ConnectionErrorCode {
  return Object.hasOwn(ERROR_COPY, code);
}

/** Stable code of a database error message (`'LINK_MISMATCH: ...'` → `LINK_MISMATCH`), or null. */
export function connectionErrorCode(message: string | null | undefined): string | null {
  return /^([A-Z][A-Z0-9_]*):/.exec(message ?? "")?.[1] ?? null;
}

/** Human copy for a database error; raw SQL text is never shown. */
export function connectionErrorMessage(message: string | null | undefined): string {
  const code = connectionErrorCode(message);
  return code !== null && isKnownCode(code) ? ERROR_COPY[code] : DEFAULT_ERROR;
}

export type ServiceFailure = { ok: false; code: string | null; error: string };
export type ServiceResult<T> = ({ ok: true } & T) | ServiceFailure;

function failure(databaseMessage: string | null | undefined): ServiceFailure {
  return { ok: false, code: connectionErrorCode(databaseMessage), error: connectionErrorMessage(databaseMessage) };
}

function failureCode(code: ConnectionErrorCode): ServiceFailure {
  return { ok: false, code, error: ERROR_COPY[code] };
}

// ---------------------------------------------------------------------------------------------------------
// Read models (the trader's RLS client)
// ---------------------------------------------------------------------------------------------------------
const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const instant = z.string().refine(isInstant, "Expected a timestamp with an explicit timezone.");
const direction = z.enum(["LONG", "SHORT"]);
const provider = z.enum(["CTRADER", "MT5", "MOCK"]);
const linkMethod = z.enum(["AUTO_MATCH", "USER", "IMPORT_CREATED"]);
const connectionStatus = z.enum(["PENDING", "CONNECTED", "SYNCING", "SYNCED", "ERROR", "DISCONNECTED"]);
const count = z.number().int().nonnegative();
export type ConnectionStatus = z.infer<typeof connectionStatus>;
export type LinkMethod = z.infer<typeof linkMethod>;

const CONNECTION_COLUMNS = "id,account_id,provider,label,external_account_ref,created_at,currency,status,status_message,status_at,"
  + "synced_through,last_synced_at,warning_count,last_warning_at,execution_count,unmatched_count";
const connectionRow = z.object({
  id: z.uuid(), account_id: z.uuid(), provider, label: z.string(), external_account_ref: z.string().nullable(), created_at: instant,
  currency: z.string().regex(/^[A-Z]{3}$/), status: connectionStatus.nullable(), status_message: z.string().nullable(), status_at: instant.nullable(),
  synced_through: instant.nullable(), last_synced_at: instant.nullable(), warning_count: count, last_warning_at: instant.nullable(),
  execution_count: count, unmatched_count: count,
});

export interface PlatformConnection {
  id: string;
  accountId: string;
  provider: SyncProviderId;
  label: string;
  /** Masked platform account reference for display; never a secret. */
  externalAccountRef: string | null;
  createdAt: string;
  currency: string;
  /** PENDING until the first state event exists. */
  status: ConnectionStatus;
  /** Human message of the current state (errors and sync summaries), without secrets. */
  statusMessage: string | null;
  statusAt: string | null;
  /** Latest platform time ingested; the next sync asks only for later positions. */
  syncedThrough: string | null;
  lastSyncedAt: string | null;
  /** Platform payloads that need the trader's attention: changes that were not applied, closes without a realized P&L. */
  warningCount: number;
  lastWarningAt: string | null;
  executionCount: number;
  unmatchedCount: number;
}

function toConnection(row: z.infer<typeof connectionRow>): PlatformConnection {
  return {
    id: row.id, accountId: row.account_id, provider: row.provider, label: row.label, externalAccountRef: row.external_account_ref,
    createdAt: row.created_at, currency: row.currency, status: row.status ?? "PENDING", statusMessage: row.status_message, statusAt: row.status_at,
    syncedThrough: row.synced_through, lastSyncedAt: row.last_synced_at, warningCount: row.warning_count, lastWarningAt: row.last_warning_at,
    executionCount: row.execution_count, unmatchedCount: row.unmatched_count,
  };
}

/** Every connection visible to the trader (optionally of one account), oldest first. */
export async function listConnections(db: Db, options: { accountId?: string } = {}): Promise<PlatformConnection[]> {
  let query = db.from("platform_connection_overview").select(CONNECTION_COLUMNS);
  if (options.accountId !== undefined) query = query.eq("account_id", options.accountId);
  const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error("Connections are unavailable.");
  return z.array(connectionRow).parse(data).map(toConnection);
}

export async function loadConnection(db: Db, connectionId: string): Promise<PlatformConnection | null> {
  const { data, error } = await db.from("platform_connection_overview").select(CONNECTION_COLUMNS).eq("id", connectionId).limit(1);
  if (error) throw new Error("Connections are unavailable.");
  const [row] = z.array(connectionRow).parse(data);
  return row === undefined ? null : toConnection(row);
}

export type AccountConnectionMode = "MANUAL" | "PENDING" | "CONNECTED" | "SYNCING" | "SYNCED" | "ERROR";

/** Connection state of one trading account (Settings → Connections, account pages). */
export interface AccountConnectionState {
  mode: AccountConnectionMode;
  /** The active connection; null when the account is recorded manually. */
  connection: PlatformConnection | null;
  lastSyncedAt: string | null;
  /** Human error message when mode is ERROR. */
  message: string | null;
}

const MANUAL: AccountConnectionState = Object.freeze({ mode: "MANUAL", connection: null, lastSyncedAt: null, message: null });

/** One state per account: its active (not disconnected) connection decides; without one the account is Manual. */
export function accountConnectionStates(accountIds: readonly string[], connections: readonly PlatformConnection[]): Map<string, AccountConnectionState> {
  const states = new Map<string, AccountConnectionState>(accountIds.map(id => [id, MANUAL]));
  for (const connection of connections) {
    if (connection.status === "DISCONNECTED" || !states.has(connection.accountId)) continue;
    const mode: AccountConnectionMode = connection.status;
    states.set(connection.accountId, { mode, connection, lastSyncedAt: connection.lastSyncedAt, message: mode === "ERROR" ? connection.statusMessage : null });
  }
  return states;
}

/** Latest connection state of each given account, read with the trader's RLS client. */
export async function loadAccountConnectionStates(db: Db, accountIds: readonly string[]): Promise<Map<string, AccountConnectionState>> {
  return accountConnectionStates(accountIds, accountIds.length === 0 ? [] : await listConnections(db));
}

const EXECUTION_COLUMNS = "id,account_id,connection_id,provider,connection_label,external_id,symbol,direction,volume,entry_price,entered_at,"
  + "exit_price,exited_at,commission,swap,realized_pnl,currency,payload_hash,received_at,close_received_at,linked_trade_id,link_method,linked_at,"
  + "warning_count,last_warning_message,last_warning_at";
const executionRow = z.object({
  id: z.uuid(), account_id: z.uuid(), connection_id: z.uuid(), provider, connection_label: z.string(), external_id: z.string(),
  symbol: z.string(), direction, volume: decimalText, entry_price: decimalText, entered_at: instant, exit_price: decimalText.nullable(),
  exited_at: instant.nullable(), commission: decimalText.nullable(), swap: decimalText.nullable(), realized_pnl: decimalText.nullable(),
  currency: z.string(), payload_hash: z.string(), received_at: instant, close_received_at: instant.nullable(), linked_trade_id: z.uuid().nullable(),
  link_method: linkMethod.nullable(), linked_at: instant.nullable(), warning_count: count, last_warning_message: z.string().nullable(),
  last_warning_at: instant.nullable(),
});

/** A platform position in its effective state: the first version plus its platform close, when one arrived later. */
export interface ExternalExecution {
  id: string;
  accountId: string;
  connectionId: string;
  provider: SyncProviderId;
  connectionLabel: string;
  /** Platform position (ticket) id. */
  externalId: string;
  symbol: string;
  direction: Direction;
  volume: string;
  entryPrice: string;
  enteredAt: string;
  exitPrice: string | null;
  exitedAt: string | null;
  commission: string | null;
  swap: string | null;
  /** The platform's net realized P&L, in `currency`. */
  realizedPnl: string | null;
  currency: string;
  /** Technical details only. */
  payloadHash: string;
  receivedAt: string;
  /** When Trading OS learned that the position was closed; null while it is open. */
  closeReceivedAt: string | null;
  linkedTradeId: string | null;
  linkMethod: LinkMethod | null;
  linkedAt: string | null;
  /** Versions of this position that need the trader's attention: changes that were not applied, a close without a realized P&L. */
  warningCount: number;
  lastWarningMessage: string | null;
  lastWarningAt: string | null;
}

function toExecution(row: z.infer<typeof executionRow>): ExternalExecution {
  return {
    id: row.id, accountId: row.account_id, connectionId: row.connection_id, provider: row.provider, connectionLabel: row.connection_label,
    externalId: row.external_id, symbol: row.symbol, direction: row.direction, volume: row.volume, entryPrice: row.entry_price,
    enteredAt: row.entered_at, exitPrice: row.exit_price, exitedAt: row.exited_at, commission: row.commission, swap: row.swap,
    realizedPnl: row.realized_pnl, currency: row.currency, payloadHash: row.payload_hash, receivedAt: row.received_at,
    closeReceivedAt: row.close_received_at, linkedTradeId: row.linked_trade_id, linkMethod: row.link_method, linkedAt: row.linked_at,
    warningCount: row.warning_count, lastWarningMessage: row.last_warning_message, lastWarningAt: row.last_warning_at,
  };
}

export const UNMATCHED_LIMIT = 100;
/** Default page of `listLinkedExecutions`. */
export const LINKED_LIMIT = 100;
const MAX_EXECUTION_PAGE = 500;

export interface ExecutionListOptions {
  /** One trading account; every account the session can read when absent. */
  accountId?: string;
  /** Page size, clamped to 1..500. */
  limit?: number;
}

/**
 * One page of the session's executions in their effective state (`external_execution_status`, RLS scoped), by current
 * link state, newest entry first (then by id, so pages are stable).
 */
async function listExecutions(db: Db, linked: boolean, options: ExecutionListOptions, defaultLimit: number): Promise<ExternalExecution[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? defaultLimit), 1), MAX_EXECUTION_PAGE);
  const all = db.from("external_execution_status").select(EXECUTION_COLUMNS);
  let query = linked ? all.not("linked_trade_id", "is", null) : all.is("linked_trade_id", null);
  if (options.accountId !== undefined) query = query.eq("account_id", options.accountId);
  const { data, error } = await query.order("entered_at", { ascending: false }).order("id", { ascending: true }).limit(limit);
  if (error) throw new Error("Platform executions are unavailable.");
  return z.array(executionRow).parse(data).map(toExecution);
}

/** Stored executions without a linked trade (held as ambiguous, or unlinked by the trader), newest entry first. */
export function listUnmatchedExecutions(db: Db, options: ExecutionListOptions = {}): Promise<ExternalExecution[]> {
  return listExecutions(db, false, options, UNMATCHED_LIMIT);
}

/**
 * Stored executions currently linked to a trade, newest entry first: automatic matches and trader links to planned
 * trades (`linkMethod` AUTO_MATCH / USER, which the trader may unlink) and positions imported as trades
 * (IMPORT_CREATED, linked for good). An execution the trader unlinked is no longer here; `listUnmatchedExecutions`
 * lists it again.
 */
export function listLinkedExecutions(db: Db, options: ExecutionListOptions = {}): Promise<ExternalExecution[]> {
  return listExecutions(db, true, options, LINKED_LIMIT);
}

// ---------------------------------------------------------------------------------------------------------
// Planned trades an execution may belong to (the trader's RLS client)
// ---------------------------------------------------------------------------------------------------------
const CANDIDATE_COLUMNS = "id,account_id,origin,lifecycle,symbol,direction,locked_at,planned_entry,planned_stop,instrument_version_id";
const candidateRow = z.object({
  id: z.uuid(), account_id: z.uuid(), origin: z.enum(TRADE_ORIGINS), lifecycle: z.enum(LIFECYCLES), symbol: z.string().nullable(),
  direction: direction.nullable(), locked_at: instant.nullable(), planned_entry: decimalText.nullable(), planned_stop: decimalText.nullable(),
  instrument_version_id: z.uuid().nullable(),
});
const CANDIDATE_PAGE = 500;
const IN_FILTER_CHUNK = 100;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

/** Planned trades of an account in the given lifecycle states, with tick size and current link state. */
async function plannedCandidates(db: Db, accountId: string, lifecycles: readonly Lifecycle[]): Promise<SyncCandidate[]> {
  const rows: z.infer<typeof candidateRow>[] = [];
  for (let cursor: string | null = null; ;) {
    let query = db.from("trade_ledger").select(CANDIDATE_COLUMNS).eq("account_id", accountId).eq("origin", "PLANNED").in("lifecycle", [...lifecycles]);
    if (cursor !== null) query = query.gt("id", cursor);
    const { data, error } = await query.order("id", { ascending: true }).limit(CANDIDATE_PAGE);
    if (error) throw new Error("Planned trades are unavailable.");
    const page = z.array(candidateRow).parse(data);
    rows.push(...page);
    if (page.length < CANDIDATE_PAGE) break;
    cursor = page[page.length - 1].id;
  }

  const tickSizes = new Map<string, string>();
  const instrumentIds = [...new Set(rows.flatMap(row => (row.instrument_version_id === null ? [] : [row.instrument_version_id])))];
  for (const ids of chunks(instrumentIds, IN_FILTER_CHUNK)) {
    const { data, error } = await db.from("instrument_versions").select("id,tick_size::text").in("id", ids);
    if (error) throw new Error("Instruments are unavailable.");
    for (const row of z.array(z.object({ id: z.uuid(), tick_size: decimalText })).parse(data)) tickSizes.set(row.id, row.tick_size);
  }

  const linked = new Set<string>();
  for (const ids of chunks(rows.map(row => row.id), IN_FILTER_CHUNK)) {
    const { data, error } = await db.from("external_execution_status").select("linked_trade_id").in("linked_trade_id", ids);
    if (error) throw new Error("Platform executions are unavailable.");
    for (const row of z.array(z.object({ linked_trade_id: z.uuid() })).parse(data)) linked.add(row.linked_trade_id);
  }

  return rows.map(row => ({
    tradeId: row.id, accountId: row.account_id, origin: row.origin, lifecycle: row.lifecycle, linked: linked.has(row.id), symbol: row.symbol,
    direction: row.direction, lockedAt: row.locked_at, plannedEntry: row.planned_entry, plannedStop: row.planned_stop,
    tickSize: row.instrument_version_id === null ? null : tickSizes.get(row.instrument_version_id) ?? null,
  }));
}

/** A trader may link any locked plan that was not skipped or cancelled; automatic links need LOCKED or LIVE. */
export const USER_LINK_LIFECYCLES: readonly Lifecycle[] = Object.freeze(["LOCKED", "LIVE", "CLOSED", "REVIEWED"]);
const AUTO_LINK_LIFECYCLES: readonly Lifecycle[] = Object.freeze(["LOCKED", "LIVE"]);

export interface LinkCandidate extends SyncCandidate {
  lockedAt: string;
  /** Satisfies the automatic matching rules (30-minute window and price tolerance). */
  suggested: boolean;
}

/**
 * Planned trades the trader can link a stored execution to, under the rules the database enforces:
 * same account, instrument and direction, locked at or before the execution's entry, not linked yet.
 * Suggested candidates first, then the latest lock.
 */
export async function listLinkCandidates(db: Db, execution: ExternalExecution): Promise<LinkCandidate[]> {
  const position = { accountId: execution.accountId, symbol: execution.symbol, direction: execution.direction, entryPrice: execution.entryPrice, enteredAt: execution.enteredAt };
  const eligible: LinkCandidate[] = [];
  for (const candidate of await plannedCandidates(db, execution.accountId, USER_LINK_LIFECYCLES)) {
    const { lockedAt, symbol } = candidate;
    if (candidate.linked || lockedAt === null || symbol === null || candidate.direction !== execution.direction) continue;
    if (normalizeSymbol(symbol) !== normalizeSymbol(execution.symbol) || compareInstants(lockedAt, execution.enteredAt) > 0) continue;
    eligible.push({ ...candidate, lockedAt, suggested: matchExecution(position, [candidate]).kind === "UNIQUE" });
  }
  return eligible.sort((a, b) => Number(b.suggested) - Number(a.suggested) || compareInstants(b.lockedAt, a.lockedAt) || (a.tradeId < b.tradeId ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------
// Sync store: candidates through RLS, ingest through the service role with the session's user id.
// ---------------------------------------------------------------------------------------------------------
/** ingest_external_execution returns exactly the domain store outcomes. */
const INGEST_OUTCOMES = ["CREATED", "LINKED", "HELD", "UNCHANGED", "CLOSED", "CHANGED"] as const satisfies readonly IngestOutcome[];
const ingestEnvelope = z.object({ outcome: z.enum(INGEST_OUTCOMES), executionId: z.uuid(), tradeId: z.uuid().nullable() });

export interface SyncStoreOptions {
  /** The trader's RLS client. */
  db: Db;
  /** Service-role client (trusted server). */
  admin: Db;
  /** From the verified session; the database re-checks that it owns the connection. */
  userId: string;
  connection: SyncConnection;
}

export class SupabaseSyncStore implements SyncStore {
  private candidates: Promise<SyncCandidate[]> | null = null;
  private readonly affected = new Set<string>();

  constructor(private readonly options: SyncStoreOptions) {}

  /** Planned LOCKED/LIVE trades of the connection's account, loaded once per run; the matcher applies the rules. */
  listCandidates(): Promise<readonly SyncCandidate[]> {
    this.candidates ??= plannedCandidates(this.options.db, this.options.connection.accountId, AUTO_LINK_LIFECYCLES);
    return this.candidates;
  }

  async ingest(position: ExternalPosition, decision: IngestDecision): Promise<IngestOutcome> {
    const { admin, userId, connection } = this.options;
    const { data, error } = await admin.rpc("ingest_external_execution", {
      p_user_id: userId, p_connection_id: connection.id, p_execution: position, p_decision: decision,
    });
    // runSync reports a fixed message; the database text never leaves the server.
    if (error) throw new Error(connectionErrorCode(error.message) ?? "INGEST_FAILED");
    const { outcome, tradeId } = ingestEnvelope.parse(data);
    if ((outcome === "CREATED" || outcome === "LINKED" || outcome === "CLOSED") && tradeId !== null) this.affected.add(tradeId);
    return outcome;
  }

  /** Trades created, linked or closed by this run, sorted. */
  get affectedTradeIds(): string[] {
    return [...this.affected].sort();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sync orchestration
// ---------------------------------------------------------------------------------------------------------
const STATUS_MESSAGE_LIMIT = 300;
const SYNC_FAILED = "Sync stopped before finishing. Positions already imported are kept; run the sync again to continue.";
const SYNC_STATUS_UNSAVED = "The sync result could not be saved. Imported positions are kept; run the sync again.";

export interface SyncSummary {
  accountId: string;
  report: SyncReport;
  /** The run's human summary (`report.message`), also recorded as the connection's status message. */
  message: string;
  /** Platform closes appended by this run (`report.closed`). */
  closed: number;
  /** Trades created, linked or closed by this run, sorted. */
  tradeIds: string[];
}
export type SyncRunResult = ServiceResult<SyncSummary>;

function recordStatus(admin: Db, userId: string, connectionId: string, status: "SYNCING" | "SYNCED" | "ERROR", message: string | null, syncedThrough: string | null) {
  return admin.rpc("record_platform_sync_status", {
    p_user_id: userId, p_connection_id: connectionId, p_status: status,
    p_message: message === null ? null : message.slice(0, STATUS_MESSAGE_LIMIT), p_synced_through: syncedThrough,
  });
}

export interface SyncRunOptions {
  /** The trader's RLS client. */
  db: Db;
  /** Service-role client (trusted server). */
  admin: Db;
  /** From the verified session. */
  userId: string;
  connection: PlatformConnection;
  provider: ExecutionSyncProvider;
  /** Server time; positions later than this are rejected. */
  now: Instant;
}

/** One sync: SYNCING → fetch, validate, match and ingest (domain runSync) → SYNCED or ERROR. */
export async function syncConnection(options: SyncRunOptions): Promise<SyncRunResult> {
  const { db, admin, userId, connection, provider, now } = options;
  if (connection.status === "DISCONNECTED") return failureCode("CONNECTION_DISCONNECTED");
  const started = await recordStatus(admin, userId, connection.id, "SYNCING", null, null);
  if (started.error) return failure(started.error.message);
  const target: SyncConnection = {
    id: connection.id, accountId: connection.accountId, accountCurrency: connection.currency, provider: connection.provider,
    syncedThrough: connection.syncedThrough,
  };
  const store = new SupabaseSyncStore({ db, admin, userId, connection: target });
  let report: SyncReport;
  try {
    report = await runSync(target, provider, store, { now });
  } catch {
    await recordStatus(admin, userId, connection.id, "ERROR", SYNC_FAILED, null);
    return { ok: false, code: null, error: SYNC_FAILED };
  }
  const finished = report.status === "SYNCED"
    ? await recordStatus(admin, userId, connection.id, "SYNCED", report.message, report.syncedThrough)
    : await recordStatus(admin, userId, connection.id, "ERROR", report.message, null);
  if (finished.error) return { ok: false, code: connectionErrorCode(finished.error.message), error: SYNC_STATUS_UNSAVED };
  return { ok: true, accountId: connection.accountId, report, message: report.message, closed: report.closed, tradeIds: store.affectedTradeIds };
}

// ---------------------------------------------------------------------------------------------------------
// Commands for server actions; each takes the user from the verified session.
// ---------------------------------------------------------------------------------------------------------
export async function connectMockPlatform(input: { accountId: string; label: string; requestKey: string }): Promise<ServiceResult<{ connectionId: string }>> {
  if (!isMockSyncEnabled()) return { ok: false, code: "PROVIDER_NOT_AVAILABLE", error: MOCK_SYNC_UNAVAILABLE };
  const { db } = await requireUser();
  const { data, error } = await db.rpc("create_platform_connection", {
    p_account_id: input.accountId, p_provider: "MOCK", p_label: input.label, p_request_key: input.requestKey,
  });
  if (error) return failure(error.message);
  return { ok: true, connectionId: z.uuid().parse(data) };
}

const disconnectEnvelope = z.object({ connectionId: z.uuid(), accountId: z.uuid(), status: z.literal("DISCONNECTED") });

export async function disconnectPlatform(connectionId: string): Promise<ServiceResult<{ connectionId: string; accountId: string }>> {
  const { db } = await requireUser();
  const { data, error } = await db.rpc("disconnect_platform_connection", { p_connection_id: connectionId });
  if (error) return failure(error.message);
  const envelope = disconnectEnvelope.parse(data);
  return { ok: true, connectionId: envelope.connectionId, accountId: envelope.accountId };
}

/** Developer "Simulate sync": the mock provider against the trader's own mock connection. */
export async function simulateMockSync(connectionId: string): Promise<SyncRunResult> {
  if (!isMockSyncEnabled()) return { ok: false, code: "PROVIDER_NOT_AVAILABLE", error: MOCK_SYNC_UNAVAILABLE };
  const { db, user } = await requireUser();
  const connection = await loadConnection(db, connectionId);
  if (connection === null) return failureCode("CONNECTION_NOT_FOUND");
  if (connection.provider !== "MOCK") return failureCode("PROVIDER_NOT_AVAILABLE");
  return syncConnection({ db, admin: trustedServer(), userId: user.id, connection, provider: new MockSyncProvider(), now: new Date() });
}

const linkEnvelope = z.object({
  linkId: z.number().int().positive(), tradeId: z.uuid(), executionId: z.uuid(), accountId: z.uuid(), action: z.enum(["LINK", "UNLINK"]),
  method: linkMethod, recordedAt: instant, replayed: z.boolean(),
});
export type LinkResult = ServiceResult<{ tradeId: string; executionId: string; accountId: string; replayed: boolean }>;

async function changeLink(rpc: "link_external_execution" | "unlink_external_execution", tradeId: string, executionId: string): Promise<LinkResult> {
  const { db } = await requireUser();
  const { data, error } = await db.rpc(rpc, { p_trade_id: tradeId, p_execution_id: executionId });
  if (error) return failure(error.message);
  const envelope = linkEnvelope.parse(data);
  return { ok: true, tradeId: envelope.tradeId, executionId: envelope.executionId, accountId: envelope.accountId, replayed: envelope.replayed };
}

/** Trader confirmation: link a stored execution to one of their planned trades. */
export function linkPlatformExecution(tradeId: string, executionId: string): Promise<LinkResult> {
  return changeLink("link_external_execution", tradeId, executionId);
}

export function unlinkPlatformExecution(tradeId: string, executionId: string): Promise<LinkResult> {
  return changeLink("unlink_external_execution", tradeId, executionId);
}
