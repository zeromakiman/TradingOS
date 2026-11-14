import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { LEDGER_COLUMNS, LIFECYCLES, TRADE_ORIGINS } from "@/domain/ledger";
import { compareInstants, instantComparer } from "@/domain/time-display";
import { classifyTiming, type EvidenceLabel, inferStoredPhase, legacyEvidenceLabel, type StoredPhase, type Timing } from "@/domain/timeline";
import { planEndedAt } from "@/domain/trade-state";
import { RequestError } from "./route-security";

/**
 * "Export my data" (docs/V2_ARCHITECTURE.md §10.5). Every part is read with the signed-in user's own session, so
 * row-level security scopes it a second time; the secret key is never used. Each table is read in keyset order
 * over its real primary key until an empty page comes back, so neither PostgREST's max-rows cap nor concurrent
 * inserts can silently truncate or duplicate rows. NUMERIC columns are selected as text: exact decimal strings.
 *
 *   GET /api/export?part=core|trades|ai|evidence-manifest    whole part as JSON
 *   GET /api/export?part=trades-csv                          one CSV row per trade (trade_ledger)
 *   GET /api/export?part=<json part>&table=<name>[&after=c]  one page of one table, with `next` (null at the end);
 *                                                            for accounts whose part outgrows response limits.
 *                                                            Pages of trade_evidence and setup_screenshots also
 *                                                            carry the evidence manifest items of their rows.
 */

export const EXPORT_SCHEMA = "2.0";
export const EXPORT_PARTS = ["core", "trades", "ai", "evidence-manifest", "trades-csv"] as const;
export type ExportPart = (typeof EXPORT_PARTS)[number];
export type JsonExportPart = Exclude<ExportPart, "trades-csv">;

export interface ExportTable {
  /** Table (or view) in schema public. */
  name: string;
  /** Primary key columns: the keyset order. */
  key: readonly string[];
  /** NUMERIC columns, exported as exact decimal strings. */
  numeric: readonly string[];
}

const table = (name: string, key: readonly string[] = ["id"], numeric: readonly string[] = []): ExportTable => ({ name, key, numeric });

/** Every tenant table, in exactly one part (enforced against the catalog by tests/v2-export.test.ts). */
export const EXPORT_TABLES: Readonly<Record<JsonExportPart, readonly ExportTable[]>> = {
  core: [
    table("accounts"),
    table("account_profiles", ["id"], ["starting_balance"]),
    table("bootstrap_requests", ["user_id", "idempotency_key"]),
    table("strategy_versions"),
    table("risk_plan_versions", ["id"], ["max_risk_percent", "default_risk_percent", "min_rr", "daily_risk_cap", "daily_loss_cap"]),
    table("instrument_versions", ["id"], ["tick_size", "pip_size", "tick_value", "quantity_step", "minimum_quantity"]),
    table("account_observations", ["id"], ["equity", "balance", "gross_loss_today"]),
    table("external_loss_entries", ["id"], ["amount"]),
    table("external_loss_removals", ["entry_id"]),
    table("configuration_events"),
    table("daily_contexts"),
    table("strategy_experiments"),
    table("experiment_reviews"),
    table("platform_connections"),
    table("platform_connection_events"),
  ],
  trades: [
    table("trades"),
    table("trade_revisions", ["proposal_id"]),
    table("setup_proposals"),
    table("risk_evaluations"),
    table("setup_risk_checks"),
    table("setup_locks", ["proposal_id"]),
    table("setup_human_decisions"),
    table("trade_plans", ["id"], ["nominal_risk"]),
    table("trade_plan_links", ["trade_id"]),
    table("trade_executions", ["id"], ["entry_price", "quantity", "initial_risk"]),
    table("trade_outcomes", ["id"], ["exit_price", "fees", "gross_pnl", "net_pnl", "realized_r"]),
    table("trade_dispositions"),
    table("trade_position_facts", ["id"], ["entry_price", "quantity", "initial_stop", "risk_amount"]),
    table("trade_unplanned_closes", ["trade_id"], ["exit_price", "fees", "gross_pnl", "net_pnl", "risk_basis", "realized_r"]),
    table("trade_journal_entries"),
    table("trade_lifecycle_events"),
    table("trade_tag_revisions"),
    table("trade_tag_sets"),
    table("trade_events"),
    table("trade_reviews"),
    table("chart_assets"),
    table("plan_chart_assets", ["plan_id", "asset_id"]),
    table("external_executions", ["id"], ["volume", "entry_price", "exit_price", "commission", "swap", "realized_pnl"]),
    table("external_execution_closes", ["external_execution_id"], ["exit_price", "commission", "swap", "realized_pnl"]),
    table("trade_execution_links"),
    // 0020: Deleted-trades events and custom models.
    table("trade_trash_events"),
    table("custom_models"),
    table("custom_model_revisions"),
    table("trade_custom_models"),
  ],
  ai: [
    table("ai_preference_events"),
    table("ai_request_reservations"),
    table("ai_request_dispatches", ["reservation_id"]),
    table("ai_request_generations", ["reservation_id"]),
    table("ai_usage_records", ["reservation_id"]),
    table("ai_uncertainty_resolutions"),
    table("ai_analysis_attempts"),
    table("setup_evaluations"),
    table("setup_evaluation_screenshots", ["evaluation_id", "screenshot_id"]),
    table("setup_evaluation_events"),
    table("setup_evaluation_passes"),
    table("bias_challenges"),
    table("bias_challenge_results", ["challenge_id"]),
    table("trade_ai_reviews"),
    table("trade_ai_review_results", ["review_id"]),
    table("trade_timeline_reviews"),
    table("trade_timeline_review_results", ["review_id"]),
    table("weekly_ai_reviews"),
    table("weekly_ai_review_results", ["review_id"]),
    table("recent_ai_analyses"),
    table("recent_ai_analysis_results", ["review_id"]),
    table("monthly_ai_reviews"),
    table("monthly_ai_review_results", ["review_id"]),
  ],
  "evidence-manifest": [
    table("trade_evidence"),
    table("trade_evidence_labels"),
    table("trade_evidence_removals", ["evidence_id"]),
    table("setup_screenshots"),
    table("setup_screenshot_removals", ["screenshot_id"]),
  ],
};

type Row = Record<string, unknown>;
type KeyValue = string | number;

export interface EvidenceManifestItem {
  id: string;
  kind: "V2" | "LEGACY";
  tradeId: string | null;
  /** Legacy screenshots belong to a draft revision (setup proposal). */
  proposalId: string | null;
  label: EvidenceLabel;
  /** Legacy timeframe role (`DAILY`, `H4`, ...); null for V2 evidence. */
  role: string | null;
  timeframe: string | null;
  caption: string | null;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  recordedAt: string;
  /** Before entry / While live / After close (§5.3); null for a legacy screenshot outside any trade. */
  timing: Timing | null;
  removedAt: string | null;
  captureMethod: string | null;
  copiedFrom: string | null;
  /** Owner-only download route (the user's session and the storage policy apply again). */
  downloadPath: string;
}

export interface ExportDocument {
  exportedAt: string;
  schema: typeof EXPORT_SCHEMA;
  part: JsonExportPart;
  user: { id: string; email: string | null };
  tables: Record<string, Row[]>;
  /**
   * evidence-manifest only: one item per legacy screenshot and V2 evidence item, removed ones included. The whole
   * part carries every item; a page of trade_evidence or setup_screenshots carries the items of exactly its rows.
   */
  manifest?: EvidenceManifestItem[];
  /** Paged requests only: pass as `after` to read the next page; null when the table is complete. */
  next?: string | null;
}

export type ExportRequest =
  | { part: "trades-csv" }
  | { part: JsonExportPart; page: null }
  | { part: JsonExportPart; page: { table: ExportTable; after: KeyValue[] | null } };

export type ExportUser = Pick<User, "id" | "email">;

const READ_FAILED = "Your data could not be exported right now. Nothing was changed; please try again.";
/** Rows per PostgREST request; also correct when the server caps a response at fewer rows. */
const PAGE_ROWS = 1000;
/** Paged mode: stop adding rows once the serialized page reaches this size (Vercel caps responses at 4.5 MB). */
const PAGE_BUDGET_BYTES = 3 * 1024 * 1024;
const PAGED_FETCH_ROWS = 200;
/** Values per `in` lookup: keeps request URLs short (100 uuids are about 3.7 KB). */
const LOOKUP_VALUES = 100;
const EXACT_SUFFIX = "__exact";
const KEY_VALUE = /^[0-9A-Za-z-]{1,64}$/;

class ExportReadError extends Error {}

function columnsFor(entry: ExportTable): string {
  return ["*", ...entry.numeric.map((column) => `${column}${EXACT_SUFFIX}:${column}::text`)].join(",");
}

/** Replaces each NUMERIC column, which PostgREST sends as a lossy JSON number, by its exact text. */
function exactRow(row: Row, entry: ExportTable): Row {
  return Object.fromEntries(Object.entries(row)
    .filter(([column]) => !column.endsWith(EXACT_SUFFIX))
    .map(([column, value]) => [column, entry.numeric.includes(column) ? (row[`${column}${EXACT_SUFFIX}`] ?? null) : value]));
}

function keyOf(row: Row, key: readonly string[]): KeyValue[] {
  return key.map((column) => {
    const value = row[column];
    if ((typeof value !== "string" && typeof value !== "number") || !KEY_VALUE.test(String(value))) throw new ExportReadError("Unexpected key value.");
    return value;
  });
}

/** Key tuples in PostgreSQL order: integers numerically; canonical lower-case uuid text matches uuid byte order. */
function compareKeys(a: readonly KeyValue[], b: readonly KeyValue[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const [x, y] = [a[i], b[i]];
    if (x === y) continue;
    if (typeof x === "number" || typeof y === "number") return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `(k1, k2) > (v1, v2)` as a PostgREST `or` filter. Values are validated uuids or integers. */
function keysetFilter(key: readonly string[], after: readonly KeyValue[]): string {
  return key.map((column, i) => {
    const equal = key.slice(0, i).map((previous, j) => `${previous}.eq.${after[j]}`);
    const greater = `${column}.gt.${after[i]}`;
    return equal.length === 0 ? greater : `and(${[...equal, greater].join(",")})`;
  }).join(",");
}

/** Restricts a read to the rows whose `column` is one of `values`. */
interface InFilter {
  column: string;
  values: readonly string[];
}

/** Restricts a read to the rows whose `column` equals `value`. */
interface EqualFilter {
  column: string;
  value: string;
}

async function readPage(
  db: SupabaseClient, entry: ExportTable, after: readonly KeyValue[] | null, limit: number, columns = columnsFor(entry), filter?: InFilter | EqualFilter,
): Promise<Row[]> {
  let query = db.from(entry.name).select(columns);
  if (filter) query = "value" in filter ? query.eq(filter.column, filter.value) : query.in(filter.column, [...filter.values]);
  for (const column of entry.key) query = query.order(column, { ascending: true });
  if (after) query = entry.key.length === 1 ? query.gt(entry.key[0], after[0]) : query.or(keysetFilter(entry.key, after));
  const { data, error } = await query.limit(limit);
  if (error || !Array.isArray(data)) throw new ExportReadError("Read failed.");
  const rows = (data as unknown[]).map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new ExportReadError("Unexpected row.");
    return exactRow(row as Row, entry);
  });
  // Keyset order must strictly advance; anything else would loop forever or duplicate rows.
  let previous = after;
  for (const row of rows) {
    const current = keyOf(row, entry.key);
    if (previous && compareKeys(current, previous) <= 0) throw new ExportReadError("Keyset order did not advance.");
    previous = current;
  }
  return rows;
}

async function readTable(db: SupabaseClient, entry: ExportTable, columns?: string, filter?: InFilter | EqualFilter): Promise<Row[]> {
  const rows: Row[] = [];
  for (let after: KeyValue[] | null = null; ;) {
    const page = await readPage(db, entry, after, PAGE_ROWS, columns, filter);
    if (page.length === 0) return rows;
    rows.push(...page);
    after = keyOf(page[page.length - 1], entry.key);
  }
}

/** Every row of `entry` whose `column` is one of `values`, looked up a URL-sized chunk of distinct values at a time. */
async function readWhereIn(db: SupabaseClient, entry: ExportTable, column: string, values: readonly string[], columns?: string): Promise<Row[]> {
  const distinct = [...new Set(values)];
  const rows: Row[] = [];
  for (let start = 0; start < distinct.length; start += LOOKUP_VALUES) {
    rows.push(...await readTable(db, entry, columns, { column, values: distinct.slice(start, start + LOOKUP_VALUES) }));
  }
  return rows;
}

/**
 * Every ledger row of the user, one account at a time (each in keyset order): the ledger derives most columns per row, so
 * a keyset page over every account makes PostgreSQL compute every remaining trade of the user before it can sort them
 * by id (the CSV of 19,900 trades took 29-43 s and of 45,000 trades 41-44 s, against the route's 60 s limit). The ledger holds
 * exactly the trades of the accounts RLS lists, so their union is every row; without accounts the read is whole.
 */
async function readLedger(db: SupabaseClient, columns: string): Promise<Row[]> {
  const accounts = await readTable(db, ACCOUNTS, "id");
  if (accounts.length === 0) return readTable(db, LEDGER, columns);
  const rows: Row[] = [];
  for (const account of accounts) rows.push(...await readTable(db, LEDGER, columns, { column: "account_id", value: String(account.id) }));
  return rows;
}

async function readTables(db: SupabaseClient, entries: readonly ExportTable[]): Promise<Record<string, Row[]>> {
  const tables: Record<string, Row[]> = {};
  for (const entry of entries) tables[entry.name] = await readTable(db, entry);
  return tables;
}

interface TablePage {
  rows: Row[];
  /** Pages of trade_evidence and setup_screenshots only: the manifest items of exactly these rows, in row order. */
  manifest: EvidenceManifestItem[] | null;
  next: KeyValue[] | null;
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Rows (and their manifest items) up to the response budget, which counts both. */
async function readTablePage(db: SupabaseClient, entry: ExportTable, start: KeyValue[] | null): Promise<TablePage> {
  const describe = MANIFEST_PAGES[entry.name];
  const rows: Row[] = [];
  const manifest: EvidenceManifestItem[] = [];
  const page = (next: KeyValue[] | null): TablePage => ({ rows, manifest: describe ? manifest : null, next });
  let bytes = 0;
  for (let after = start; ;) {
    const batch = await readPage(db, entry, after, PAGED_FETCH_ROWS);
    if (batch.length === 0) return page(null);
    const items = describe ? new Map((await describe(db, batch)).map((item) => [item.id, item])) : null;
    for (const row of batch) {
      rows.push(row);
      bytes += jsonBytes(row);
      if (items) {
        const item = items.get(String(row.id));
        if (!item) throw new ExportReadError("Missing manifest item.");
        manifest.push(item);
        bytes += jsonBytes(item);
      }
      if (bytes >= PAGE_BUDGET_BYTES) return page(keyOf(row, entry.key));
    }
    after = keyOf(batch[batch.length - 1], entry.key);
  }
}

export function encodeCursor(values: readonly KeyValue[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, entry: ExportTable): KeyValue[] {
  try {
    const values: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(values) && values.length === entry.key.length
      && values.every((value) => (typeof value === "string" || Number.isSafeInteger(value)) && KEY_VALUE.test(String(value)))) {
      return values as KeyValue[];
    }
  } catch {
    // Reported below with the same message as any other malformed cursor.
  }
  throw new RequestError("Invalid export cursor.", 400);
}

function isExportPart(value: string | null): value is ExportPart {
  return EXPORT_PARTS.some((part) => part === value);
}

export function parseExportRequest(params: URLSearchParams): ExportRequest {
  const part = params.get("part");
  if (!isExportPart(part)) throw new RequestError("Unknown export part.", 400);
  const tableName = params.get("table");
  const after = params.get("after");
  if (part === "trades-csv") {
    if (tableName !== null || after !== null) throw new RequestError("The trades CSV is exported whole.", 400);
    return { part };
  }
  if (tableName === null) {
    if (after !== null) throw new RequestError("A cursor needs a table.", 400);
    return { part, page: null };
  }
  const entry = EXPORT_TABLES[part].find((candidate) => candidate.name === tableName);
  if (!entry) throw new RequestError("Unknown export table.", 400);
  return { part, page: { table: entry, after: after === null ? null : decodeCursor(after, entry) } };
}

const timestamp = z.string().min(1);
const evidenceRow = z.object({
  id: z.uuid(), trade_id: z.uuid(), label: z.string(), timeframe: z.string().nullable(), caption: z.string().nullable(),
  original_filename: z.string(), mime_type: z.string(), byte_size: z.number().int(), width: z.number().int(), height: z.number().int(),
  sha256: z.string(), phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]), capture_method: z.string(), copied_from: z.uuid().nullable(),
  recorded_at: timestamp,
});
const evidenceLabelRow = z.object({ evidence_id: z.uuid(), label: z.string(), timeframe: z.string().nullable(), caption: z.string().nullable() });
const removalRow = z.object({ recorded_at: timestamp });
const screenshotRow = z.object({
  id: z.uuid(), proposal_id: z.uuid(), role: z.string(), original_filename: z.string(), mime_type: z.string(),
  byte_size: z.number().int(), width: z.number().int(), height: z.number().int(), sha256: z.string(), uploaded_at: timestamp,
});
const revisionRow = z.object({ proposal_id: z.uuid(), trade_id: z.uuid() });
/**
 * Ledger columns the timing band needs: entry and exit times, and what `planEndedAt` reads to date a plan's end
 * (`entry_price` is read as text: PostgREST sends NUMERIC as a lossy JSON number).
 */
const timingRow = z.object({
  id: z.uuid(), origin: z.enum(TRADE_ORIGINS), created_at: timestamp, entered_at: timestamp.nullable(), entry_recorded_at: timestamp.nullable(),
  entry_price: z.string().nullable(), exited_at: timestamp.nullable(), close_recorded_at: timestamp.nullable(),
  outcome: z.enum(["WIN", "LOSS", "BREAKEVEN"]).nullable(), plan_id: z.uuid().nullable(), lifecycle: z.enum(LIFECYCLES),
  disposition: z.enum(["SKIPPED", "CANCELLED"]).nullable(), legacy_decision: z.enum(["TAKEN", "SKIPPED"]).nullable(), discarded_at: timestamp.nullable(),
});
type TradeTiming = z.output<typeof timingRow>;
const endRow = z.object({ recorded_at: timestamp });

const LEDGER = table("trade_ledger");
const ACCOUNTS = table("accounts");
const REVISIONS = table("trade_revisions", ["proposal_id"]);
const DISPOSITIONS = table("trade_dispositions");
const DECISIONS = table("setup_human_decisions");
const LEDGER_TIMING_COLUMNS = [
  "id", "origin", "created_at", "entered_at", "entry_recorded_at", "entry_price::text", "exited_at", "close_recorded_at", "outcome",
  "plan_id", "lifecycle", "disposition", "legacy_decision", "discarded_at",
].join(",");
/** Planned trades that ended without an entry: only these can have an end time (`planEndedAt`). */
const ENDED_LIFECYCLES = new Set<string>(["SKIPPED", "CANCELLED", "DISCARDED"]);
const EVIDENCE_LABELS = new Set<string>(["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "EXIT", "OTHER"]);

function parseRows<T>(schema: z.ZodType<T>, rows: readonly Row[]): T[] {
  return rows.map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new ExportReadError("Unexpected evidence row.");
    return parsed.data;
  });
}

function evidenceLabel(label: string): EvidenceLabel {
  if (!EVIDENCE_LABELS.has(label)) throw new ExportReadError("Unexpected evidence label.");
  return label as EvidenceLabel;
}

function removalTimes(rows: readonly Row[], key: string): Map<string, string> {
  return new Map(rows.map((row) => [String(row[key]), parseRows(removalRow, [row])[0].recorded_at]));
}

/**
 * Every legacy screenshot and V2 evidence item with its effective label, timing band and download route. Timing is the
 * trade page's (spec §5.3): `endedAt` holds when each planned trade that ended without an entry ended (`planEnds`), so
 * what was recorded from then on is After close, never pre-entry evidence.
 */
export function buildEvidenceManifest(
  tables: Readonly<Record<string, readonly Row[]>>, revisions: readonly Row[], trades: readonly Row[], endedAt: ReadonlyMap<string, string> = new Map(),
): EvidenceManifestItem[] {
  const tradeById = new Map(parseRows(timingRow, trades).map((trade) => [trade.id, trade]));
  const tradeOfProposal = new Map(parseRows(revisionRow, revisions).map((revision) => [revision.proposal_id, revision.trade_id]));
  // Relabel history is append-only; the newest row (highest identity) wins.
  const labels = new Map<string, z.output<typeof evidenceLabelRow>>();
  const labelRows = [...(tables.trade_evidence_labels ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
  for (const row of parseRows(evidenceLabelRow, labelRows)) labels.set(row.evidence_id, row);
  const evidenceRemovals = removalTimes(tables.trade_evidence_removals ?? [], "evidence_id");
  const screenshotRemovals = removalTimes(tables.setup_screenshot_removals ?? [], "screenshot_id");
  // Records without a stored phase (legacy screenshots) get the one private.trade_phase would have stored.
  const timing = (trade: TradeTiming | undefined, recordedAt: string, storedPhase: StoredPhase | null): Timing | null => {
    if (!trade) return null;
    const ended = endedAt.get(trade.id) ?? null;
    const entryRecordedAt = trade.entry_recorded_at ?? (trade.origin === "PLANNED" ? null : trade.created_at);
    return classifyTiming({
      recordedAt, storedPhase: storedPhase ?? inferStoredPhase(recordedAt, entryRecordedAt, trade.close_recorded_at, ended), origin: trade.origin,
      entryAt: trade.entered_at, entryRecordedAt, exitAt: trade.exited_at, tradeCreatedAt: trade.created_at, endedAt: ended,
    }).timing;
  };

  const v2 = parseRows(evidenceRow, tables.trade_evidence ?? []).map((item): EvidenceManifestItem => {
    const current = labels.get(item.id);
    return {
      id: item.id, kind: "V2", tradeId: item.trade_id, proposalId: null, label: evidenceLabel(current?.label ?? item.label), role: null,
      timeframe: current ? current.timeframe : item.timeframe, caption: current ? current.caption : item.caption,
      originalFilename: item.original_filename, mimeType: item.mime_type, byteSize: item.byte_size, width: item.width, height: item.height,
      sha256: item.sha256, recordedAt: item.recorded_at, timing: timing(tradeById.get(item.trade_id), item.recorded_at, item.phase),
      removedAt: evidenceRemovals.get(item.id) ?? null, captureMethod: item.capture_method, copiedFrom: item.copied_from,
      downloadPath: `/api/evidence/${item.id}`,
    };
  });
  const legacy = parseRows(screenshotRow, tables.setup_screenshots ?? []).map((item): EvidenceManifestItem => {
    const tradeId = tradeOfProposal.get(item.proposal_id) ?? null;
    const trade = tradeId ? tradeById.get(tradeId) : undefined;
    return {
      id: item.id, kind: "LEGACY", tradeId, proposalId: item.proposal_id, label: legacyEvidenceLabel(item.role), role: item.role, timeframe: item.role,
      caption: null, originalFilename: item.original_filename, mimeType: item.mime_type, byteSize: item.byte_size, width: item.width,
      height: item.height, sha256: item.sha256, recordedAt: item.uploaded_at, timing: timing(trade, item.uploaded_at, null),
      removedAt: screenshotRemovals.get(item.id) ?? null, captureMethod: null, copiedFrom: null, downloadPath: `/api/screenshots/${item.id}`,
    };
  });
  return [...v2, ...legacy].sort((a, b) => compareInstants(a.recordedAt, b.recordedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const LABEL_HISTORY = table("trade_evidence_labels");
const EVIDENCE_REMOVALS = table("trade_evidence_removals", ["evidence_id"]);
const SCREENSHOT_REMOVALS = table("setup_screenshot_removals", ["screenshot_id"]);

type ManifestPage = (db: SupabaseClient, rows: readonly Row[]) => Promise<EvidenceManifestItem[]>;

const columnValues = (rows: readonly Row[], column: string) => rows.map((row) => String(row[column]));

/**
 * When each planned trade of `trades` that ended without an entry ended: `planEndedAt` (`private.plan_ended_at`), the
 * earliest of its discard, the skip or cancellation of its plan and a latest V1 skip, exactly as the trade page dates
 * it. Only the dispositions and V1 decisions the ledger names are read, a URL-sized chunk of values at a time; the V1
 * decisions of a trade lie on any of its revisions, so `revisions` must hold every revision of the trades (the whole
 * table), else (null) the revisions of the trades with a V1 skip are read.
 */
async function planEnds(db: SupabaseClient, trades: readonly Row[], revisions: readonly Row[] | null): Promise<Map<string, string>> {
  const ended = parseRows(timingRow, trades).filter((trade) => trade.origin === "PLANNED" && ENDED_LIFECYCLES.has(trade.lifecycle));
  const planIds = ended.flatMap((trade) => (trade.disposition !== null && trade.plan_id !== null ? [trade.plan_id] : []));
  const skipped = new Set(ended.filter((trade) => trade.legacy_decision === "SKIPPED").map((trade) => trade.id));
  const tradeOfProposal = new Map(parseRows(revisionRow, revisions ?? await readWhereIn(db, REVISIONS, "trade_id", [...skipped]))
    .filter((revision) => skipped.has(revision.trade_id)).map((revision) => [revision.proposal_id, revision.trade_id]));
  const dispositionAt = new Map((await readWhereIn(db, DISPOSITIONS, "plan_id", planIds, "id,plan_id,recorded_at"))
    .map((row) => [String(row.plan_id), parseRows(endRow, [row])[0].recorded_at]));
  // The ledger names a trade's latest V1 decision; it is a skip here, recorded at the latest decision time of the trade.
  const legacySkipAt = new Map<string, string>();
  for (const row of await readWhereIn(db, DECISIONS, "proposal_id", [...tradeOfProposal.keys()], "id,proposal_id,recorded_at")) {
    const tradeId = tradeOfProposal.get(String(row.proposal_id));
    const at = parseRows(endRow, [row])[0].recorded_at;
    const latest = tradeId ? legacySkipAt.get(tradeId) : undefined;
    if (tradeId && (latest === undefined || compareInstants(at, latest) > 0)) legacySkipAt.set(tradeId, at);
  }
  const ends = new Map<string, string>();
  for (const trade of ended) {
    const at = planEndedAt(trade, { dispositionAt: trade.plan_id ? dispositionAt.get(trade.plan_id) ?? null : null, legacySkipAt: legacySkipAt.get(trade.id) ?? null });
    if (at !== null) ends.set(trade.id, at);
  }
  return ends;
}

/**
 * Paged mode: the manifest items of one page of evidence rows, built from only the labels, removals, revisions, ledger
 * timing and plan ends those rows need, so the whole manifest arrives page by page within the response budget.
 */
const MANIFEST_PAGES: Partial<Record<string, ManifestPage>> = {
  trade_evidence: async (db, rows) => {
    const trades = await readWhereIn(db, LEDGER, "id", columnValues(rows, "trade_id"), LEDGER_TIMING_COLUMNS);
    return buildEvidenceManifest(
      {
        trade_evidence: rows,
        trade_evidence_labels: await readWhereIn(db, LABEL_HISTORY, "evidence_id", columnValues(rows, "id")),
        trade_evidence_removals: await readWhereIn(db, EVIDENCE_REMOVALS, "evidence_id", columnValues(rows, "id")),
      },
      [],
      trades,
      await planEnds(db, trades, null),
    );
  },
  setup_screenshots: async (db, rows) => {
    const revisions = await readWhereIn(db, REVISIONS, "proposal_id", columnValues(rows, "proposal_id"));
    const trades = await readWhereIn(db, LEDGER, "id", columnValues(revisions, "trade_id"), LEDGER_TIMING_COLUMNS);
    return buildEvidenceManifest(
      { setup_screenshots: rows, setup_screenshot_removals: await readWhereIn(db, SCREENSHOT_REMOVALS, "screenshot_id", columnValues(rows, "id")) },
      revisions,
      trades,
      await planEnds(db, trades, null),
    );
  },
};

const FORMULA_START = /^[=+@\t\r\n]/;
const PLAIN_NEGATIVE_NUMBER = /^-[\d.]+$/;

/** One CSV cell, guarded against spreadsheet formula injection exactly like the V1 CSV (`tradeCsv` at bc5441c). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join("; ") : String(value);
  if (FORMULA_START.test(text) || (text.startsWith("-") && !PLAIN_NEGATIVE_NUMBER.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** UTF-8 BOM (spreadsheets otherwise guess a legacy code page), CRLF rows, one row per trade by creation time. */
export function ledgerCsv(rows: readonly Row[]): string {
  const compare = instantComparer();
  const sorted = [...rows].sort((a, b) => compare(String(a.created_at), String(b.created_at)) || (String(a.id) < String(b.id) ? -1 : 1));
  const lines = [LEDGER_COLUMNS.join(","), ...sorted.map((row) => LEDGER_COLUMNS.map((column) => csvCell(row[column])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

function exportHeaders(contentType: string, filename: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Builds the response for an authenticated user; `db` must be that user's RLS session. */
export async function exportResponse(db: SupabaseClient, user: ExportUser, params: URLSearchParams, now: Date = new Date()): Promise<Response> {
  const request = parseExportRequest(params);
  const day = now.toISOString().slice(0, 10);
  try {
    if (request.part === "trades-csv") {
      const ledger = await readLedger(db, LEDGER_COLUMNS.join(","));
      return new Response(ledgerCsv(ledger), { headers: exportHeaders("text/csv; charset=utf-8", `trading-os-trades-${day}.csv`) });
    }
    const document: ExportDocument = {
      exportedAt: now.toISOString(), schema: EXPORT_SCHEMA, part: request.part, user: { id: user.id, email: user.email ?? null }, tables: {},
    };
    let filename = `trading-os-${request.part}-${day}.json`;
    if (request.page) {
      const { rows, manifest, next } = await readTablePage(db, request.page.table, request.page.after);
      document.tables[request.page.table.name] = rows;
      if (manifest) document.manifest = manifest;
      document.next = next ? encodeCursor(next) : null;
      filename = `trading-os-${request.part}-${request.page.table.name}-${day}.json`;
    } else {
      document.tables = await readTables(db, EXPORT_TABLES[request.part]);
      if (request.part === "evidence-manifest") {
        const [revisions, trades] = [await readTable(db, REVISIONS), await readLedger(db, LEDGER_TIMING_COLUMNS)];
        document.manifest = buildEvidenceManifest(document.tables, revisions, trades, await planEnds(db, trades, revisions));
      }
    }
    return new Response(JSON.stringify(document), { headers: exportHeaders("application/json; charset=utf-8", filename) });
  } catch (error) {
    if (error instanceof ExportReadError) throw new RequestError(READ_FAILED, 503);
    throw error;
  }
}
