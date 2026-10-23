import "server-only";
import Decimal from "decimal.js";
import { cache } from "react";
import { z } from "zod";
import type { AccountStatus } from "@/domain/account-metrics";
import type { EvidenceIndex } from "@/domain/ai-summary";
import { formatR, stripZeros } from "@/domain/format";
import { ENTRY_MODELS, type EntryModel, LEDGER_COLUMNS, type LedgerTrade, LIFECYCLES, type Lifecycle, ledgerRow, TRADE_ORIGINS, type TradeOrigin } from "@/domain/ledger";
import { type PlanVsReality, planVsReality } from "@/domain/plan-vs-reality";
import type { Instrument } from "@/domain/risk";
import { type ExplainedReport, type ExplainLookup, explainReport, riskStatusLine } from "@/domain/risk-explain";
import { type StoredRiskReport, storedRiskSchema } from "@/domain/risk-report";
import { type Session, strategyClock } from "@/domain/session";
import {
  addDays, formatDay, instantMicros, isCalendarDay, isInstant, STRATEGY_TIME, strategyDay, type TimeDisplay, WEEKDAY_NAMES, weekdayIndex,
} from "@/domain/time-display";
import {
  buildTimeline, type CheckExplainLookup, classifyTiming, type EvidenceLabel, evidenceName, groupByTiming, inferStoredPhase, legacyEvidenceLabel,
  type StoredPhase, TIMING_FLAG_COPY, TIMING_LABELS, type TimelineAiAnalysis, type TimelineEvidence, type TimelineItem, type Timing, type TimingFlag,
  type TimingGroup,
} from "@/domain/timeline";
import { deriveTradeState, type TradeState } from "@/domain/trade-state";
import { accountDirectory, type ContextAccount, currentSession, type Db, getAccountContext, getPreferences } from "./account-context";
import { accountAiAvailability } from "./ai-budget";
import { loadTradeAiHistory, type TradeAiHistory, timelineAiAnalyses } from "./ai-history";
import {
  type AccountWorkspace, INSTRUMENT_SELECT, isCheckCurrent, loadAccountWorkspace, parseInstrumentRows, parseRiskPlanRow, RISK_PLAN_SELECT, toInstrument,
} from "./workspace";

/**
 * Trade data (docs/V2_ARCHITECTURE.md §2, §5.4, §7.5, §14.4, §14.5), read with the user's session: every row is RLS
 * scoped, and tables with a user column are additionally filtered by the verified user id.
 * - `listTrades`: the Journal list over `public.trade_ledger` (strict `ledgerRow` parsing), ordered and grouped by trade
 *   date (entry time if executed, else lock time, else creation time), with keyset pagination over that computed key.
 * - `getTradeDetail`: the trade workspace view model built from every timeline source of §5.4 through the pure domain
 *   modules; ids, hashes and raw reports appear only inside `technical`.
 * - `loadPaletteIndex`: the shell's light command-palette index.
 */

const D = Decimal.clone({ precision: 60 });

export const JOURNAL_PAGE_SIZE = 50;
/** Ledger rows examined per page request at most; a page that hits it returns a cursor to continue. */
const MAX_SCAN = 2000;
const SCAN_BATCH = 100;
/** Trades matched through journal text or tags per search (the rest of a search runs on the ledger itself). */
export const SEARCH_MATCH_LIMIT = 150;
const SOURCE_LIMIT = 1000;
/** Values per PostgREST `in` filter: keeps every request URL well below gateway limits (100 ids ≈ 3.7 KB). */
export const IN_FILTER_BATCH = 100;

/** `values` in consecutive batches of at most `size` (for `in` filters). */
export function inBatches<T>(values: readonly T[], size = IN_FILTER_BATCH): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) batches.push(values.slice(start, start + size));
  return batches;
}
/**
 * Exactly the ledger contract's columns, so the strict `ledgerRow` schema detects drift between the view and the code.
 * Typed as `*` for supabase-js (which would otherwise try to parse a non-literal column list): every row is validated
 * by `ledgerRow` instead.
 */
const LEDGER_SELECT = LEDGER_COLUMNS.join(",") as "*";

// ---------------------------------------------------------------------------------------------------------
// Filters (spec §14.5): URL state of the Journal and the drill-down target of EDGE, Accounts and Today.
// ---------------------------------------------------------------------------------------------------------
export const TRADE_RESULTS = ["WIN", "LOSS", "BREAKEVEN", "OPEN"] as const;
export type TradeResultFilter = (typeof TRADE_RESULTS)[number];
export const SESSIONS = ["ASIA", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL"] as const satisfies readonly Session[];
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

export interface TradeFilters {
  /** Trade date range (strategy days, inclusive): entry day if executed, else lock day, else creation day. */
  from?: string;
  to?: string;
  /** Exit day range (strategy days, inclusive), for calendar drill-downs. */
  closedFrom?: string;
  closedTo?: string;
  result?: TradeResultFilter;
  states?: Lifecycle[];
  origin?: TradeOrigin;
  model?: EntryModel;
  /** Session of the entry time (fixed UTC−5); only executed trades match. */
  session?: Session;
  /** Weekday of the entry day; only executed trades match. */
  weekday?: WeekdayName;
  direction?: "LONG" | "SHORT";
  /** true: reviewed; false: closed with the review pending. */
  reviewed?: boolean;
  /** Completed AI trade reviews (V1 and timeline-aware), as trade_ai_activity counts them. */
  aiReviewed?: boolean;
  /** Every tag must be present (effective V2 tags). */
  tags?: string[];
  instrument?: string;
  /** Requested risk percent of the plan (exact). */
  riskPercent?: string;
  strategyVersionId?: string;
  riskPlanVersionId?: string;
  /** Realized R in [rFrom, rTo) (R-distribution bins); trades without realized R never match. */
  rFrom?: string;
  rTo?: string;
  /** Free text over instrument, tags and journal text. */
  q?: string;
}

export type FilterParams = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function readAll(params: FilterParams, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key);
  const value = params[key];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

function readOne(params: FilterParams, key: string): string | undefined {
  const values = readAll(params, key).map(value => value.trim()).filter(Boolean);
  return values.length ? values[values.length - 1] : undefined;
}

function listParam(params: FilterParams, key: string): string[] {
  return readAll(params, key).flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
}

const SIGNED_DECIMAL = /^-?\d{1,12}(\.\d{1,20})?$/;
const POSITIVE_DECIMAL = /^\d{1,12}(\.\d{1,8})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;
const TAG = /^[a-z0-9][a-z0-9 _-]{0,31}$/;

function enumValue<T extends string>(values: readonly T[], raw: string | undefined): T | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.toUpperCase().replace(/-/g, "_");
  return values.find(value => value === normalized);
}

/** Canonical tag text: trimmed, lowercase, single spaces. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Journal filters from URL search parameters. Unknown values are ignored and named in `invalid`, so a malformed link
 * still shows the list (never an error page).
 */
export function parseTradeFilters(params: FilterParams): { filters: TradeFilters; invalid: string[] } {
  const filters: TradeFilters = {};
  const invalid: string[] = [];
  const day = (key: "from" | "to" | "closedFrom" | "closedTo") => {
    const value = readOne(params, key);
    if (value === undefined) return;
    if (isCalendarDay(value)) filters[key] = value;
    else invalid.push(key);
  };
  day("from");
  day("to");
  day("closedFrom");
  day("closedTo");
  const pick = <T extends string>(key: string, values: readonly T[], assign: (value: T) => void) => {
    const raw = readOne(params, key);
    if (raw === undefined) return;
    const value = enumValue(values, raw);
    if (value === undefined) invalid.push(key);
    else assign(value);
  };
  pick("result", TRADE_RESULTS, value => { filters.result = value; });
  pick("origin", TRADE_ORIGINS, value => { filters.origin = value; });
  pick("model", ENTRY_MODELS, value => { filters.model = value; });
  pick("session", SESSIONS, value => { filters.session = value; });
  pick("direction", ["LONG", "SHORT"] as const, value => { filters.direction = value; });
  const states = listParam(params, "state");
  if (states.length) {
    const parsed = states.map(state => enumValue(LIFECYCLES, state));
    if (parsed.every((state): state is Lifecycle => state !== undefined)) filters.states = [...new Set(parsed)];
    else invalid.push("state");
  }
  const weekday = readOne(params, "weekday");
  if (weekday !== undefined) {
    const match = WEEKDAY_NAMES.find(name => name.toLowerCase() === weekday.toLowerCase());
    if (match) filters.weekday = match;
    else invalid.push("weekday");
  }
  const flag = (key: "reviewed" | "ai", assign: (value: boolean) => void) => {
    const raw = readOne(params, key)?.toLowerCase();
    if (raw === undefined) return;
    if (raw === "yes" || raw === "true") assign(true);
    else if (raw === "no" || raw === "false") assign(false);
    else invalid.push(key);
  };
  flag("reviewed", value => { filters.reviewed = value; });
  flag("ai", value => { filters.aiReviewed = value; });
  const tags = listParam(params, "tag").map(normalizeTag);
  if (tags.length) {
    if (tags.every(tag => TAG.test(tag))) filters.tags = [...new Set(tags)];
    else invalid.push("tag");
  }
  const instrument = readOne(params, "instrument")?.toUpperCase();
  if (instrument !== undefined) {
    if (SYMBOL.test(instrument)) filters.instrument = instrument;
    else invalid.push("instrument");
  }
  const risk = readOne(params, "risk");
  if (risk !== undefined) {
    if (POSITIVE_DECIMAL.test(risk) && new D(risk).gt(0)) filters.riskPercent = stripZeros(risk);
    else invalid.push("risk");
  }
  const id = (key: "strategy" | "riskPlan", assign: (value: string) => void) => {
    const raw = readOne(params, key)?.toLowerCase();
    if (raw === undefined) return;
    if (UUID.test(raw)) assign(raw);
    else invalid.push(key);
  };
  id("strategy", value => { filters.strategyVersionId = value; });
  id("riskPlan", value => { filters.riskPlanVersionId = value; });
  const bound = (key: "rFrom" | "rTo") => {
    const raw = readOne(params, key);
    if (raw === undefined) return;
    if (SIGNED_DECIMAL.test(raw)) filters[key] = stripZeros(raw);
    else invalid.push(key);
  };
  bound("rFrom");
  bound("rTo");
  const q = readOne(params, "q");
  if (q !== undefined) filters.q = q.slice(0, 100);
  return { filters, invalid };
}

/** URL search parameters for filters, in a stable order (the inverse of `parseTradeFilters`). */
export function tradeFilterParams(filters: TradeFilters): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => { if (value !== undefined && value !== "") params.set(key, value); };
  set("from", filters.from);
  set("to", filters.to);
  set("closedFrom", filters.closedFrom);
  set("closedTo", filters.closedTo);
  set("result", filters.result?.toLowerCase());
  if (filters.states?.length) params.set("state", filters.states.map(state => state.toLowerCase()).join(","));
  set("origin", filters.origin?.toLowerCase().replace(/_/g, "-"));
  set("model", filters.model);
  set("session", filters.session);
  set("weekday", filters.weekday);
  set("direction", filters.direction?.toLowerCase());
  if (filters.reviewed !== undefined) params.set("reviewed", filters.reviewed ? "yes" : "no");
  if (filters.aiReviewed !== undefined) params.set("ai", filters.aiReviewed ? "yes" : "no");
  for (const tag of filters.tags ?? []) params.append("tag", tag);
  set("instrument", filters.instrument);
  set("risk", filters.riskPercent);
  set("strategy", filters.strategyVersionId);
  set("riskPlan", filters.riskPlanVersionId);
  set("rFrom", filters.rFrom);
  set("rTo", filters.rTo);
  set("q", filters.q);
  return params;
}

/**
 * `/journal?…` for the filters. `account` switches the context explicitly (the proxy stores it); omit it to stay in
 * the current context. Links that switch the context must not be prefetched (`<Link prefetch={false}>`).
 */
export function journalHref(filters: TradeFilters, options: { account?: string } = {}): string {
  const params = tradeFilterParams(filters);
  if (options.account) params.set("account", options.account);
  const query = params.toString();
  return query ? `/journal?${query}` : "/journal";
}

// ---------------------------------------------------------------------------------------------------------
// Trade date and keyset cursor.
// ---------------------------------------------------------------------------------------------------------
export type TradeDateSource = "ENTRY" | "LOCK" | "CREATED";

/** The instant a trade is dated by (spec §14.5) and which fact it came from. */
export function tradeDate(trade: Pick<LedgerTrade, "entered_at" | "locked_at" | "created_at">): { at: string; source: TradeDateSource } {
  if (trade.entered_at !== null) return { at: trade.entered_at, source: "ENTRY" };
  if (trade.locked_at !== null) return { at: trade.locked_at, source: "LOCK" };
  return { at: trade.created_at, source: "CREATED" };
}

interface CursorPosition {
  /** The trade-date instant exactly as the database returned it. */
  t: string;
  id: string;
}

export function encodeTradeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/** Null for anything that is not a cursor this module wrote (the list then starts from the newest trade). */
export function decodeTradeCursor(cursor: string | null | undefined): CursorPosition | null {
  if (!cursor || cursor.length > 400) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z.object({ t: z.string().refine(isInstant), id: z.string().regex(UUID) }).strict().safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Descending order key: later trade date first, then the larger id. */
function compareDesc(a: { micros: bigint; id: string }, b: { micros: bigint; id: string }): number {
  if (a.micros !== b.micros) return a.micros > b.micros ? -1 : 1;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

function dayStart(day: string): string {
  return `${day}T05:00:00Z`;
}

function dayEnd(day: string): string {
  return `${addDays(day, 1)}T05:00:00Z`;
}

// ---------------------------------------------------------------------------------------------------------
// Scope and pushdown.
// ---------------------------------------------------------------------------------------------------------
/** Accounts a query covers: one account, or every account the session can read (All Accounts, through RLS). */
export type TradeScope = { mode: "account"; accountId: string } | { mode: "all" };

interface Stream {
  source: TradeDateSource;
  column: "entered_at" | "locked_at" | "created_at";
}

const STREAMS: readonly Stream[] = [
  { source: "ENTRY", column: "entered_at" },
  { source: "LOCK", column: "locked_at" },
  { source: "CREATED", column: "created_at" },
];

/** `trade_ledger` with exactly the contract's columns. */
export function ledgerSelect(db: Db) {
  return db.from("trade_ledger").select(LEDGER_SELECT);
}
export type LedgerSelect = ReturnType<typeof ledgerSelect>;

/**
 * Applies every filter PostgREST can evaluate on the ledger (all but the trade-date range, session, weekday and R
 * bounds) plus the account scope. `searchIds` are the trades matched by journal text or tags for `filters.q`.
 */
export function applyLedgerFilters(query: LedgerSelect, scope: TradeScope, filters: TradeFilters, searchIds: readonly string[] | null): LedgerSelect {
  let q = query;
  if (scope.mode === "account") q = q.eq("account_id", scope.accountId);
  if (filters.closedFrom) q = q.gte("exited_at", dayStart(filters.closedFrom));
  if (filters.closedTo) q = q.lt("exited_at", dayEnd(filters.closedTo));
  if (filters.result === "OPEN") q = q.eq("lifecycle", "LIVE");
  else if (filters.result) q = q.eq("outcome", filters.result);
  if (filters.states?.length) q = q.in("lifecycle", filters.states);
  if (filters.reviewed !== undefined) q = q.eq("lifecycle", filters.reviewed ? "REVIEWED" : "CLOSED");
  if (filters.origin) q = q.eq("origin", filters.origin);
  if (filters.model) q = q.eq("entry_model", filters.model);
  if (filters.direction) q = q.eq("direction", filters.direction);
  if (filters.aiReviewed !== undefined) q = filters.aiReviewed ? q.gt("ai_review_count", 0) : q.eq("ai_review_count", 0);
  if (filters.tags?.length) q = q.contains("tags", filters.tags);
  if (filters.instrument) q = q.eq("symbol", filters.instrument);
  if (filters.riskPercent) q = q.eq("requested_risk_percent", filters.riskPercent);
  if (filters.strategyVersionId) q = q.eq("strategy_version_id", filters.strategyVersionId);
  if (filters.riskPlanVersionId) q = q.eq("risk_plan_version_id", filters.riskPlanVersionId);
  if (filters.rFrom !== undefined || filters.rTo !== undefined) q = q.not("realized_r", "is", null);
  if (filters.q !== undefined) {
    const symbol = searchSymbol(filters.q);
    const terms = [...(symbol ? [`symbol.ilike.*${symbol}*`] : []), ...(searchIds?.length ? [`id.in.(${searchIds.join(",")})`] : [])];
    // Nothing can match a search without a symbol part or a matching journal/tag record.
    q = terms.length ? q.or(terms.join(",")) : q.in("id", []);
  }
  return q;
}

function streamQuery(db: Db, stream: Stream, scope: TradeScope, filters: TradeFilters, searchIds: readonly string[] | null, after: CursorPosition | null) {
  let q = applyLedgerFilters(ledgerSelect(db), scope, filters, searchIds);
  if (stream.source === "ENTRY") q = q.not("entered_at", "is", null);
  else q = q.is("entered_at", null);
  if (stream.source === "LOCK") q = q.not("locked_at", "is", null);
  if (stream.source === "CREATED") q = q.is("locked_at", null);
  if (filters.from) q = q.gte(stream.column, dayStart(filters.from));
  if (filters.to) q = q.lt(stream.column, dayEnd(filters.to));
  // Values are double-quoted so PostgREST never reads the timestamp's punctuation as filter syntax.
  if (after) q = q.or(`${stream.column}.lt."${after.t}",and(${stream.column}.eq."${after.t}",id.lt."${after.id}")`);
  return q;
}

/** The symbol part of a search: letters, digits and . _ / - only (the PostgREST pattern stays literal). */
export function searchSymbol(q: string): string {
  return q.toUpperCase().replace(/[^A-Z0-9._/-]/g, "").slice(0, 20);
}

/** `%`, `_` and `\` matched literally by ILIKE; `*` (PostgREST's wildcard alias) dropped. */
function likePattern(q: string): string {
  return `%${q.replace(/\*/g, "").replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

/**
 * Trades whose journal text, legacy V1 notes or tags match the search (newest records first, at most
 * SEARCH_MATCH_LIMIT trades). The ledger query then matches these ids or the instrument.
 */
export async function searchTradeIds(db: Db, userId: string, scope: TradeScope, q: string): Promise<string[]> {
  const text = q.trim();
  if (!text) return [];
  const pattern = likePattern(text);
  const tag = normalizeTag(text);
  let journalQuery = db.from("trade_journal_entries").select("trade_id,recorded_at").eq("user_id", userId).ilike("body", pattern);
  let notesQuery = db.from("trade_events").select("plan_id,recorded_at").eq("user_id", userId).eq("event_type", "NOTE_ADDED").ilike("payload->>note", pattern);
  let tagQuery = db.from("trade_ledger").select("id").contains("tags", [tag]);
  if (scope.mode === "account") {
    journalQuery = journalQuery.eq("account_id", scope.accountId);
    notesQuery = notesQuery.eq("account_id", scope.accountId);
    tagQuery = tagQuery.eq("account_id", scope.accountId);
  }
  const [journal, notes, tagged] = await Promise.all([
    journalQuery.order("recorded_at", { ascending: false }).limit(SEARCH_MATCH_LIMIT),
    notesQuery.order("recorded_at", { ascending: false }).limit(SEARCH_MATCH_LIMIT),
    TAG.test(tag) ? tagQuery.order("created_at", { ascending: false }).limit(SEARCH_MATCH_LIMIT) : Promise.resolve({ data: [], error: null }),
  ]);
  if (journal.error || notes.error || tagged.error) throw new Error("Search is unavailable.");
  const planIds = [...new Set(z.array(z.object({ plan_id: z.uuid() })).parse(notes.data ?? []).map(row => row.plan_id))];
  const links = planIds.length
    ? await db.from("trade_plan_links").select("trade_id").eq("user_id", userId).in("plan_id", planIds)
    : { data: [], error: null };
  if (links.error) throw new Error("Search is unavailable.");
  const ids = [
    ...z.array(z.object({ trade_id: z.uuid() })).parse(journal.data ?? []).map(row => row.trade_id),
    ...z.array(z.object({ trade_id: z.uuid() })).parse(links.data ?? []).map(row => row.trade_id),
    ...z.array(z.object({ id: z.uuid() })).parse(tagged.data ?? []).map(row => row.id),
  ];
  return [...new Set(ids)].slice(0, SEARCH_MATCH_LIMIT);
}

/** Filters evaluated in TypeScript on parsed rows: entry session and weekday, realized R bounds. */
export function postFilter(trade: LedgerTrade, filters: TradeFilters): boolean {
  if (filters.session || filters.weekday) {
    if (trade.entered_at === null) return false;
    if (filters.session && strategyClock(trade.entered_at).session !== filters.session) return false;
    if (filters.weekday && WEEKDAY_NAMES[weekdayIndex(strategyDay(trade.entered_at))] !== filters.weekday) return false;
  }
  if (filters.rFrom !== undefined || filters.rTo !== undefined) {
    if (trade.realized_r === null) return false;
    const r = new D(trade.realized_r);
    if (filters.rFrom !== undefined && r.lt(filters.rFrom)) return false;
    if (filters.rTo !== undefined && r.gte(filters.rTo)) return false;
  }
  return true;
}

/** Strict parsing of ledger rows: a column added to or removed from the view fails loudly (contract drift). */
export function parseLedger(data: unknown): LedgerTrade[] {
  const rows = z.array(z.unknown()).parse(data ?? []);
  return rows.map(row => ledgerRow.parse(row));
}

/** The trade-date range of the filters (strategy days of entry, else lock, else creation). */
export function inTradeDateRange(trade: LedgerTrade, filters: Pick<TradeFilters, "from" | "to">): boolean {
  if (!filters.from && !filters.to) return true;
  const day = strategyDay(tradeDate(trade).at);
  return (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
}

export interface LedgerPage {
  rows: LedgerTrade[];
  /** Continue after the last examined row; null when every matching trade was returned. */
  nextCursor: string | null;
  scanned: number;
}

/** A blank search is no search. */
export function normalizeFilters(filters: TradeFilters): TradeFilters {
  if (filters.q === undefined || filters.q.trim() !== "") return filters;
  const { q: _blank, ...rest } = filters;
  return rest;
}

/**
 * One page of ledger rows ordered by trade date (descending), then id. Trade date is a computed key, so the ledger is
 * read as three keyset streams (dated by entry, lock or creation time) merged in TypeScript; a row is emitted only
 * once no unread row of any stream can still precede it. Session, weekday and R filters run on the parsed rows, so
 * the scan continues until the page is full, every stream is exhausted, or MAX_SCAN rows were examined.
 */
export async function loadLedgerPage(db: Db, userId: string, scope: TradeScope, raw: TradeFilters, cursor: string | null, limit = JOURNAL_PAGE_SIZE): Promise<LedgerPage> {
  const filters = normalizeFilters(raw);
  const size = Math.min(Math.max(1, Math.trunc(limit)), 200);
  const searchIds = filters.q !== undefined ? await searchTradeIds(db, userId, scope, filters.q) : null;
  if (filters.q !== undefined && !searchSymbol(filters.q) && !searchIds?.length) return { rows: [], nextCursor: null, scanned: 0 };
  const streams = filters.session || filters.weekday ? STREAMS.filter(stream => stream.source === "ENTRY") : STREAMS;
  let position = decodeTradeCursor(cursor);
  const rows: LedgerTrade[] = [];
  let scanned = 0;
  for (;;) {
    const batches = await Promise.all(streams.map(async stream => {
      const { data, error } = await streamQuery(db, stream, scope, filters, searchIds, position)
        .order(stream.column, { ascending: false }).order("id", { ascending: false }).limit(SCAN_BATCH);
      if (error) throw new Error("Trades are unavailable.");
      return parseLedger(data);
    }));
    const keyed = batches.flatMap(batch => batch.map(trade => {
      const date = tradeDate(trade);
      return { trade, t: date.at, micros: instantMicros(date.at), id: trade.id };
    }));
    keyed.sort(compareDesc);
    // A stream that filled its batch may hold unread rows just below its last row: only rows at or above the highest
    // such boundary are final.
    const boundaries = batches.filter(batch => batch.length === SCAN_BATCH).map(batch => {
      const last = batch[batch.length - 1];
      return { micros: instantMicros(tradeDate(last).at), id: last.id };
    });
    const boundary = boundaries.sort(compareDesc)[0];
    const safe = boundary ? keyed.filter(entry => compareDesc(entry, boundary) <= 0) : keyed;
    let examined = 0;
    for (const entry of safe) {
      examined += 1;
      scanned += 1;
      position = { t: entry.t, id: entry.id };
      if (postFilter(entry.trade, filters)) rows.push(entry.trade);
      if (rows.length === size) break;
    }
    const more = examined < safe.length || boundary !== undefined;
    if (rows.length === size) return { rows, nextCursor: more && position ? encodeTradeCursor(position) : null, scanned };
    if (!more) return { rows, nextCursor: null, scanned };
    if (scanned >= MAX_SCAN) return { rows, nextCursor: position ? encodeTradeCursor(position) : null, scanned };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Draft check currency (spec §2.2): "Ready to lock" only while the approval still describes the present.
// ---------------------------------------------------------------------------------------------------------
/**
 * For drafts approved today, whether each approval is still current (server time, the account's workspace). Drafts
 * approved on an earlier strategy day are never current, so nothing is loaded for them.
 */
export async function draftCheckCurrency(
  db: Db, userId: string, trades: readonly LedgerTrade[], accounts: ReadonlyMap<string, ContextAccount>, now: string,
  loaded: ReadonlyMap<string, AccountWorkspace> = new Map(),
): Promise<Map<string, boolean>> {
  const today = strategyDay(now);
  const candidates = trades.filter(trade => trade.lifecycle === "DRAFT" && trade.latest_check_decision === "APPROVED"
    && trade.latest_check_at !== null && trade.latest_check_evaluation_id !== null && strategyDay(trade.latest_check_at) === today);
  const current = new Map<string, boolean>();
  if (!candidates.length) return current;
  const evaluationIds = [...new Set(candidates.map(trade => trade.latest_check_evaluation_id as string))];
  const instrumentIds = [...new Set(candidates.map(trade => trade.instrument_version_id).filter((id): id is string => id !== null))];
  const [evaluations, instruments] = await Promise.all([
    Promise.all(inBatches(evaluationIds).map(batch => db.from("risk_evaluations").select("id,result").eq("user_id", userId).in("id", batch))),
    Promise.all(inBatches(instrumentIds).map(batch => db.from("instrument_versions").select(INSTRUMENT_SELECT).eq("user_id", userId).in("id", batch))),
  ]);
  if ([...evaluations, ...instruments].some(result => result.error)) throw new Error("Risk checks are unavailable.");
  const evaluationRows = evaluations.flatMap(result => z.array(z.object({ id: z.uuid(), result: z.unknown() })).parse(result.data ?? []));
  const reports = new Map(evaluationRows.map(row => [row.id, storedRiskSchema.safeParse(row.result)] as const));
  const contracts = new Map(instruments.flatMap(result => parseInstrumentRows(result.data)).map(row => [row.id, toInstrument(row)] as const));
  const workspaces = new Map<string, Promise<AccountWorkspace | null>>([...loaded].map(([id, workspace]) => [id, Promise.resolve(workspace)] as const));
  const workspaceOf = (accountId: string) => {
    let pending = workspaces.get(accountId);
    if (!pending) {
      const account = accounts.get(accountId);
      pending = account ? loadAccountWorkspace(db, userId, account, now) : Promise.resolve(null);
      workspaces.set(accountId, pending);
    }
    return pending;
  };
  for (const trade of candidates) {
    const parsed = reports.get(trade.latest_check_evaluation_id as string);
    const workspace = await workspaceOf(trade.account_id);
    const instrument = trade.instrument_version_id ? contracts.get(trade.instrument_version_id) ?? null : null;
    current.set(trade.id, Boolean(parsed?.success && workspace && isCheckCurrent(workspace, parsed.data, instrument)));
  }
  return current;
}

// ---------------------------------------------------------------------------------------------------------
// Journal list.
// ---------------------------------------------------------------------------------------------------------
export interface TradeAccountLabel {
  /** Handle for links to the account's pages. */
  id: string;
  name: string;
  currency: string;
  status: AccountStatus;
}

export interface EvidenceSource {
  kind: "V2" | "LEGACY";
  /** Full-size image route (owner session only). */
  src: string;
  /** WEBP thumbnail that fits 640×640. */
  thumbSrc: string;
}

export interface TradeAiActivity {
  /** Completed AI trade reviews (V1 and timeline-aware): the "AI-reviewed" icon. */
  reviews: number;
  /** Completed pre-trade analyses of any revision. */
  preTradeAnalyses: number;
  lastCompletedAt: string | null;
}

export interface TradeListRow {
  /** Handle for links and forms; the default UI never prints it. */
  id: string;
  href: string;
  trade: LedgerTrade;
  tradeAt: string;
  /** Strategy day of `tradeAt`. */
  tradeDay: string;
  tradeDateSource: TradeDateSource;
  account: TradeAccountLabel;
  state: TradeState;
  thumbnail: EvidenceSource | null;
  ai: TradeAiActivity;
}

export interface TradeListGroup {
  /** Strategy day of the trades in the group. */
  day: string;
  /** `Tue, Oct 14` (with the year when it differs from today's). */
  label: string;
  rows: TradeListRow[];
}

export interface TradeListPage {
  filters: TradeFilters;
  rows: TradeListRow[];
  /** Consecutive rows of the same trade date. */
  groups: TradeListGroup[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** Tooltip of the group headers. */
  dateDefinition: string;
}

export const TRADE_DATE_DEFINITION = "Trades are dated by their entry, else the plan lock, else when they were recorded (UTC−5 strategy days).";

export function evidenceSource(kind: "V2" | "LEGACY", id: string): EvidenceSource {
  const base = kind === "V2" ? `/api/evidence/${id}` : `/api/screenshots/${id}`;
  return { kind, src: base, thumbSrc: `${base}?variant=thumb` };
}

const activityRow = z.object({
  trade_id: z.uuid(), pre_trade_analysis_count: z.number().int().nonnegative(), trade_review_count: z.number().int().nonnegative(),
  timeline_review_count: z.number().int().nonnegative(), last_completed_at: z.string().nullable(),
});

/** trade_ai_activity of the given trades (V2 AI read model); trades without activity read as zero. */
export async function loadAiActivity(db: Db, tradeIds: readonly string[]): Promise<Map<string, TradeAiActivity>> {
  const activity = new Map<string, TradeAiActivity>();
  if (!tradeIds.length) return activity;
  const results = await Promise.all(inBatches(tradeIds).map(batch => db.from("trade_ai_activity")
    .select("trade_id,pre_trade_analysis_count,trade_review_count,timeline_review_count,last_completed_at").in("trade_id", batch)));
  if (results.some(result => result.error)) throw new Error("AI activity is unavailable.");
  for (const row of results.flatMap(result => z.array(activityRow).parse(result.data ?? []))) {
    activity.set(row.trade_id, {
      reviews: row.trade_review_count + row.timeline_review_count, preTradeAnalyses: row.pre_trade_analysis_count, lastCompletedAt: row.last_completed_at,
    });
  }
  return activity;
}

const NO_ACTIVITY: TradeAiActivity = Object.freeze({ reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null });

function accountLabel(accounts: ReadonlyMap<string, ContextAccount>, trade: LedgerTrade): TradeAccountLabel {
  const account = accounts.get(trade.account_id);
  return { id: trade.account_id, name: account?.name ?? "Trading account", currency: account?.currency ?? trade.currency, status: account?.status ?? "ACTIVE" };
}

export interface ListDeps {
  db: Db;
  userId: string;
  scope: TradeScope;
  accounts: readonly ContextAccount[];
  now: string;
  display: TimeDisplay;
  /** Workspaces already loaded for this request (server time `now`), reused to judge draft approvals. */
  workspaces?: ReadonlyMap<string, AccountWorkspace>;
}

/** Rows with labels, state, thumbnail and AI activity for parsed ledger rows. */
export async function decorateTrades(deps: Omit<ListDeps, "scope" | "display">, trades: readonly LedgerTrade[]): Promise<TradeListRow[]> {
  const directory = accountDirectory(deps.accounts);
  const [current, activity] = await Promise.all([
    draftCheckCurrency(deps.db, deps.userId, trades, directory, deps.now, deps.workspaces),
    loadAiActivity(deps.db, trades.map(trade => trade.id)),
  ]);
  return trades.map(trade => {
    const date = tradeDate(trade);
    return {
      id: trade.id,
      href: `/trades/${trade.id}`,
      trade,
      tradeAt: date.at,
      tradeDay: strategyDay(date.at),
      tradeDateSource: date.source,
      account: accountLabel(directory, trade),
      state: deriveTradeState(trade, { now: deps.now, checkCurrent: current.get(trade.id) ?? false }),
      thumbnail: trade.cover_evidence_id && trade.cover_evidence_kind ? evidenceSource(trade.cover_evidence_kind, trade.cover_evidence_id) : null,
      ai: activity.get(trade.id) ?? NO_ACTIVITY,
    };
  });
}

/** Groups consecutive rows by trade date (rows arrive ordered by trade date). */
export function groupByTradeDay(rows: readonly TradeListRow[], now: string, display: TimeDisplay = STRATEGY_TIME): TradeListGroup[] {
  const groups: TradeListGroup[] = [];
  const thisYear = strategyDay(now).slice(0, 4);
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.day === row.tradeDay) last.rows.push(row);
    else groups.push({ day: row.tradeDay, label: formatDay(row.tradeDay, display, { weekday: true, year: row.tradeDay.slice(0, 4) !== thisYear }), rows: [row] });
  }
  return groups;
}

export async function loadTradeList(deps: ListDeps, filters: TradeFilters, cursor: string | null, limit = JOURNAL_PAGE_SIZE): Promise<TradeListPage> {
  const page = await loadLedgerPage(deps.db, deps.userId, deps.scope, filters, cursor, limit);
  const rows = await decorateTrades(deps, page.rows);
  return { filters, rows, groups: groupByTradeDay(rows, deps.now, deps.display), nextCursor: page.nextCursor, dateDefinition: TRADE_DATE_DEFINITION };
}

/** The Journal list of the request's account context (spec §14.5). */
export async function listTrades(filters: TradeFilters, cursor?: string | null, limit = JOURNAL_PAGE_SIZE): Promise<TradeListPage> {
  const [{ db, user }, context, preferences] = await Promise.all([currentSession(), getAccountContext(), getPreferences()]);
  const scope: TradeScope = context.selected.mode === "account" ? { mode: "account", accountId: context.selected.account.id } : { mode: "all" };
  return loadTradeList({ db, userId: user.id, scope, accounts: context.accounts, now: new Date().toISOString(), display: preferences.timeDisplay }, filters, cursor ?? null, limit);
}

// ---------------------------------------------------------------------------------------------------------
// Command palette index (spec §13.3–13.4): accounts, live trades and the last 50 trades, labels pre-formatted.
// ---------------------------------------------------------------------------------------------------------
export interface PaletteTradeEntry {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT" | null;
  accountName: string;
  dateLabel: string;
  stateLabel: string;
  tags: string[];
  resultLabel: string | null;
}

export const PALETTE_RECENT_LIMIT = 50;
const PALETTE_LIVE_LIMIT = 50;

export async function loadPaletteTrades(deps: ListDeps): Promise<{ liveTrades: PaletteTradeEntry[]; recentTrades: PaletteTradeEntry[] }> {
  let liveQuery = ledgerSelect(deps.db).eq("lifecycle", "LIVE");
  let recentQuery = ledgerSelect(deps.db);
  if (deps.scope.mode === "account") {
    liveQuery = liveQuery.eq("account_id", deps.scope.accountId);
    recentQuery = recentQuery.eq("account_id", deps.scope.accountId);
  }
  const [live, recent] = await Promise.all([
    liveQuery.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PALETTE_LIVE_LIMIT),
    recentQuery.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PALETTE_RECENT_LIMIT),
  ]);
  if (live.error || recent.error) throw new Error("Trades are unavailable.");
  const liveRows = parseLedger(live.data);
  const recentRows = parseLedger(recent.data);
  const directory = accountDirectory(deps.accounts);
  const current = await draftCheckCurrency(deps.db, deps.userId, recentRows, directory, deps.now);
  const entry = (trade: LedgerTrade): PaletteTradeEntry => ({
    id: trade.id,
    symbol: trade.symbol ?? "Unknown instrument",
    direction: trade.direction,
    accountName: accountLabel(directory, trade).name,
    dateLabel: formatDay(tradeDate(trade).at, deps.display),
    stateLabel: deriveTradeState(trade, { now: deps.now, checkCurrent: current.get(trade.id) ?? false }).label,
    tags: trade.tags,
    resultLabel: trade.realized_r !== null && trade.exited_at !== null ? formatR(trade.realized_r) : null,
  });
  return { liveTrades: liveRows.map(entry), recentTrades: recentRows.map(entry) };
}

// ---------------------------------------------------------------------------------------------------------
// Trade detail (spec §5.4, §7.5, §8.5, §14.4).
// ---------------------------------------------------------------------------------------------------------
const record = z.record(z.string(), z.unknown());
const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const instantText = z.string().refine(isInstant, "Expected a timestamp with an explicit timezone.");
const EVIDENCE_LABELS = ["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "EXIT", "OTHER"] as const;
const TIMEFRAMES = ["DAILY", "H4", "H1", "M30", "M15", "M5", "M3", "OTHER"] as const;
const PHASES = ["PRE_ENTRY", "LIVE", "POST_TRADE"] as const;
const JOURNAL_KINDS = ["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"] as const;
const MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const revisionRow = z.object({ proposal_id: z.uuid(), revision: z.number().int().positive(), created_at: instantText });
const proposalRow = z.object({ id: z.uuid(), proposal: record, created_at: instantText, instrument_version_id: z.uuid() });
const checkRow = z.object({
  id: z.number().int(), proposal_id: z.uuid(),
  risk: z.object({
    id: z.uuid(), result: z.unknown(), recorded_at: instantText, risk_plan_version_id: z.uuid().nullable(), instrument_version_id: z.uuid().nullable(),
    strategy_version_id: z.uuid().nullable(),
  }),
});
const planRow = z.object({
  id: z.uuid(), proposal: record, risk_result: z.unknown(), nominal_risk: decimalText, locked_at: instantText, trading_day: z.string(),
  account_observation_id: z.uuid(), risk_plan_version_id: z.uuid(), strategy_version_id: z.uuid(), instrument_version_id: z.uuid(),
});
const eventRow = z.object({ id: z.uuid(), event_type: z.string(), payload: record, occurred_at: instantText, recorded_at: instantText });
const dispositionRow = z.object({ status: z.enum(["SKIPPED", "CANCELLED"]), reason: z.string(), recorded_at: instantText });
const factsRow = z.object({
  id: z.uuid(), recorded_at: instantText, source: z.enum(["USER", "IMPORT"]), instrument_version_id: z.uuid().nullable(), symbol: z.string().nullable(),
  direction: z.enum(["LONG", "SHORT"]).nullable(), entry_model: z.enum(ENTRY_MODELS).nullable(), entry_price: decimalText.nullable(),
  entered_at: instantText.nullable(), quantity: decimalText.nullable(), initial_stop: decimalText.nullable(), risk_amount: decimalText.nullable(),
});
const unplannedCloseRow = z.object({ risk_basis: decimalText.nullable(), risk_basis_source: z.enum(["USER_REPORTED", "DERIVED"]).nullable() });
const journalRow = z.object({
  id: z.uuid(), kind: z.enum(JOURNAL_KINDS), body: z.string().nullable(), details: record, phase: z.enum(PHASES), state_at_creation: z.string(),
  source: z.enum(["USER", "IMPORT"]), recorded_at: instantText,
});
const evidenceRow = z.object({
  id: z.uuid(), storage_path: z.string(), label: z.enum(EVIDENCE_LABELS), timeframe: z.enum(TIMEFRAMES).nullable(), caption: z.string().nullable(),
  original_filename: z.string(), mime_type: z.enum(MIME_TYPES), byte_size: z.number().int().positive(), sha256: z.string(), width: z.number().int().positive(),
  height: z.number().int().positive(), phase: z.enum(PHASES), state_at_creation: z.string(), capture_method: z.string(), copied_from: z.uuid().nullable(),
  recorded_at: instantText,
});
const relabelRow = z.object({ id: z.number().int(), evidence_id: z.uuid(), label: z.enum(EVIDENCE_LABELS), timeframe: z.enum(TIMEFRAMES).nullable(), caption: z.string().nullable(), recorded_at: instantText });
const removalRow = z.object({ evidence_id: z.uuid(), recorded_at: instantText });
const screenshotRow = z.object({
  id: z.uuid(), proposal_id: z.uuid(), role: z.enum(TIMEFRAMES), storage_path: z.string(), original_filename: z.string(), mime_type: z.enum(MIME_TYPES),
  byte_size: z.number().int().positive(), sha256: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), uploaded_at: instantText,
});
const screenshotRemovalRow = z.object({ screenshot_id: z.uuid(), recorded_at: instantText });
const tagSetRow = z.object({
  id: z.number().int(), setup_grade: z.string().nullable(), liquidity_context: z.string().nullable(), mss_timeframe: z.string().nullable(),
  tags: z.array(z.string()).nullable(), recorded_at: instantText,
});
const lifecycleRow = z.object({ id: z.uuid(), event: z.enum(["DRAFT_DISCARDED", "REVIEW_COMPLETED", "REVIEW_REOPENED"]), reason: z.string().nullable(), recorded_at: instantText });
const strategyNameRow = z.object({ id: z.uuid(), version: z.string() });
const proposalFields = z.object({
  instrumentId: z.string(), direction: z.enum(["LONG", "SHORT"]), model: z.enum(["OB_FIRST_TOUCH", "OTE"]), entry: z.string(), stop: z.string().nullable(),
  target: z.string(), riskPercent: z.string(), narrative: z.string(), contractConfirmed: z.boolean(), news: z.enum(["UNKNOWN", "CLEAR", "RESTRICTED"]),
  contradiction: z.boolean(),
}).partial();

export interface ProposalView {
  /** Instrument version handle for the Edit Draft form. */
  instrumentVersionId: string | null;
  direction: "LONG" | "SHORT" | null;
  model: "OB_FIRST_TOUCH" | "OTE" | null;
  entry: string | null;
  stop: string | null;
  target: string | null;
  riskPercent: string | null;
  /** Thesis: why this trade, and what would invalidate it. */
  narrative: string | null;
  contractConfirmed: boolean | null;
  news: "UNKNOWN" | "CLEAR" | "RESTRICTED" | null;
  contradiction: boolean | null;
}

export interface CheckCalculations {
  quantity: string;
  nominalRisk: string;
  plannedRR: string;
  budget: string;
  stopDistance: string;
}

export interface CheckView {
  recordedAt: string;
  decision: "APPROVED" | "BLOCKED";
  /** Revision the check evaluated; null for checks outside the trade's revisions. */
  revision: number | null;
  /** Exact reasons (BLOCK first), warnings and notes, rendered from code + params (spec §6.5). */
  explained: ExplainedReport;
  /** `Risk Engine · Blocked — …` / `Risk Engine · Approved`. */
  statusLine: string;
  calculations: CheckCalculations | null;
}

export interface DraftView {
  revision: number;
  /** `expectedRevision` of Edit Draft and Lock plan. */
  expectedRevision: number;
  createdAt: string;
  proposal: ProposalView;
  latestCheck: CheckView | null;
  /** The latest check is APPROVED and still current at server time ("Ready to lock"). */
  checkCurrent: boolean;
}

export interface PlanView {
  lockedAt: string;
  tradingDay: string;
  riskPlanVersion: string | null;
  strategyVersion: string | null;
  proposal: ProposalView;
  check: CheckView | null;
  nominalRisk: string;
  /** "Locked plans can't be edited. Later changes are recorded in the journal." */
  immutableNote: string;
}

export interface ExecutionView {
  entryPrice: string | null;
  /** User-reported entry time; null when unknown. */
  enteredAt: string | null;
  recordedAt: string | null;
  quantity: string | null;
  plannedQuantity: string | null;
  oversize: boolean;
  initialStop: string | null;
  /** R denominator: the plan's nominal risk (planned) or the risk basis (live-first). */
  initialRisk: string | null;
  actualRisk: string | null;
}

export interface CloseView {
  exitPrice: string | null;
  exitedAt: string;
  recordedAt: string | null;
  fees: string | null;
  grossPnl: string | null;
  netPnl: string | null;
  realizedR: string | null;
  outcome: "WIN" | "LOSS" | "BREAKEVEN" | null;
  pnlSource: "CALCULATED" | "USER_REPORTED" | "IMPORTED" | null;
  /** Live-first/imported trades: whether the R basis was reported by the trader or derived from entry, stop and size. */
  riskBasisSource: "USER_REPORTED" | "DERIVED" | null;
  /** How realized R was computed, in words ("R based on locked risk" / "R based on risk recorded after entry"). */
  basisLabel: string;
}

export interface PositionFactView {
  recordedAt: string;
  source: "USER" | "IMPORT";
  /** Facts this record added, in words (`Entry 1.10000`, `Size 0.50`, …). */
  facts: string[];
}

export interface EvidenceItemView extends EvidenceSource {
  /** Handle for relabel/remove forms and AI selection. */
  id: string;
  /** `M5 chart`, `Entry screenshot`. */
  name: string;
  label: EvidenceLabel;
  timeframe: string | null;
  caption: string | null;
  timing: Timing;
  timingLabel: string;
  flags: string[];
  recordedAt: string;
  removedAt: string | null;
  /** Viewer note for copies: "Copied from an earlier trade · originally recorded …" (time formatted by the screen). */
  copiedFromRecordedAt: string | null;
  copied: boolean;
  originalFilename: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  relabelable: boolean;
  removable: boolean;
}

export interface EvidenceGroup {
  timing: Timing;
  label: string;
  items: EvidenceItemView[];
}

export interface TradeTechnical {
  tradeId: string;
  accountId: string;
  origin: TradeOrigin;
  planId: string | null;
  latestProposalId: string | null;
  proposalIds: string[];
  latestCheckEvaluationId: string | null;
  strategyVersionId: string | null;
  riskPlanVersionId: string | null;
  instrumentVersionId: string | null;
  duplicatedFrom: string | null;
  migratedFrom: string | null;
  checks: { evaluationId: string; recordedAt: string; report: unknown }[];
  planReport: unknown;
  evidence: { id: string; kind: "V2" | "LEGACY"; sha256: string; storagePath: string; captureMethod: string | null; copiedFrom: string | null; storedPhase: StoredPhase | null; stateAtCreation: string | null }[];
  /** Raw ledger row (every id and exact numeric text). */
  ledger: LedgerTrade;
}

export interface TradeDetail {
  /** Handle for every action form of the trade page. */
  tradeId: string;
  href: string;
  account: TradeAccountLabel;
  origin: TradeOrigin;
  /** `EURUSD · Long`. */
  title: string;
  symbol: string | null;
  direction: "LONG" | "SHORT" | null;
  model: EntryModel | null;
  createdAt: string;
  /** Trade page of the trade this draft was duplicated from. */
  duplicatedFromHref: string | null;
  state: TradeState;
  revisionCount: number;
  draft: DraftView | null;
  plan: PlanView | null;
  execution: ExecutionView | null;
  close: CloseView | null;
  disposition: { status: "SKIPPED" | "CANCELLED"; reason: string; recordedAt: string } | null;
  planVsReality: PlanVsReality;
  /** Records of a live-first/imported position, oldest first. */
  positionFacts: PositionFactView[];
  instrument: Omit<Instrument, "id"> | null;
  tags: { grade: string | null; liquidity: string | null; mss: string | null; tags: string[]; source: "V2" | "V1" | null };
  checks: CheckView[];
  timeline: TimelineItem[];
  timelineGroups: TimingGroup[];
  /** A source returned its row limit; the oldest records may be missing from the timeline. */
  timelineTruncated: boolean;
  evidence: { items: EvidenceItemView[]; groups: EvidenceGroup[]; activeCount: number; limit: number };
  /** Evidence labels by id for AI source chips (`resolveSourceChip`). */
  evidenceIndex: EvidenceIndex;
  review: { completedAt: string | null };
  ai: { activity: TradeAiActivity; history: TradeAiHistory | null; available: boolean };
  technical: TradeTechnical;
}

export const EVIDENCE_LIMIT = 24;

export interface DetailDeps {
  db: Db;
  userId: string;
  accounts: readonly ContextAccount[];
  now: string;
  display: TimeDisplay;
  /** Paid AI actions offered for this trade (account opted in, budget and pricing available). */
  aiAvailable: (accountId: string, lifecycle: Lifecycle) => Promise<boolean>;
  aiHistory: (tradeId: string) => Promise<TradeAiHistory | null>;
}

function rows<T>(schema: z.ZodType<T>, result: { data: unknown; error: unknown }, what: string): T[] {
  if (result.error) throw new Error(`${what} unavailable`);
  return z.array(schema).parse(result.data ?? []);
}

function single<T>(schema: z.ZodType<T>, result: { data: unknown; error: unknown }, what: string): T | null {
  if (result.error) throw new Error(`${what} unavailable`);
  return result.data === null || result.data === undefined ? null : schema.parse(result.data);
}

const EMPTY = Promise.resolve({ data: [] as unknown[], error: null });
const NONE = Promise.resolve({ data: null, error: null });

function proposalView(raw: Record<string, unknown> | null, instrumentVersionId: string | null): ProposalView {
  const value = proposalFields.safeParse(raw ?? {});
  const p = value.success ? value.data : {};
  return {
    instrumentVersionId: instrumentVersionId ?? (typeof p.instrumentId === "string" ? p.instrumentId : null),
    direction: p.direction ?? null, model: p.model ?? null, entry: p.entry ?? null, stop: p.stop ?? null, target: p.target ?? null,
    riskPercent: p.riskPercent ?? null, narrative: p.narrative ?? null, contractConfirmed: p.contractConfirmed ?? null, news: p.news ?? null,
    contradiction: p.contradiction ?? null,
  };
}

function checkView(report: StoredRiskReport, recordedAt: string, revision: number | null, lookup: ExplainLookup): CheckView {
  const explained = explainReport(report, lookup);
  const calc = report.calculations;
  return {
    recordedAt, decision: explained.decision, revision, explained, statusLine: riskStatusLine(report, lookup),
    calculations: calc ? { quantity: stripZeros(calc.quantity), nominalRisk: stripZeros(calc.nominalRisk), plannedRR: stripZeros(calc.plannedRR), budget: stripZeros(calc.budget), stopDistance: stripZeros(calc.stopDistance) } : null,
  };
}

/** Calculation basis of realized R in the §14.4 words. */
function basisLabel(trade: LedgerTrade): string {
  if (trade.realized_r === null) return "No risk was recorded, so realized R is not available.";
  return trade.origin === "PLANNED" ? "R based on locked risk" : "R based on risk recorded after entry";
}

function factWords(row: z.infer<typeof factsRow>): string[] {
  return [
    row.symbol ? `Instrument ${row.symbol}` : null,
    row.direction ? (row.direction === "LONG" ? "Long" : "Short") : null,
    row.entry_model ? `Model ${row.entry_model === "OB_FIRST_TOUCH" ? "OB first touch" : row.entry_model === "OTE" ? "OTE" : "Other"}` : null,
    row.entry_price ? `Entry ${stripZeros(row.entry_price)}` : null,
    row.entered_at ? "Entry time" : null,
    row.quantity ? `Size ${stripZeros(row.quantity)}` : null,
    row.initial_stop ? `Stop ${stripZeros(row.initial_stop)}` : null,
    row.risk_amount ? `Risk ${stripZeros(row.risk_amount)}` : null,
  ].filter((word): word is string => word !== null);
}

/** Decision of a stored report of any version, read like trade_ledger does (`decision`, else the V1 `status`). */
function storedDecision(result: unknown): "APPROVED" | "BLOCKED" {
  const value = z.object({ decision: z.enum(["APPROVED", "BLOCKED"]).optional(), status: z.string().optional() }).safeParse(result);
  if (!value.success) return "BLOCKED";
  return value.data.decision ?? (value.data.status === "RISK_APPROVED" ? "APPROVED" : "BLOCKED");
}

function titleOf(trade: LedgerTrade): string {
  const direction = trade.direction === "LONG" ? "Long" : trade.direction === "SHORT" ? "Short" : null;
  return [trade.symbol ?? "Trade", direction].filter(Boolean).join(" · ");
}

/** Loads every timeline source of one trade and builds the view model; null when the trade is not the user's. */
export async function loadTradeDetail(deps: DetailDeps, tradeId: string): Promise<TradeDetail | null> {
  const id = tradeId.toLowerCase();
  if (!UUID.test(id)) return null;
  const { db, userId } = deps;
  const [owned, ledgerResult] = await Promise.all([
    db.from("trades").select("id").eq("id", id).eq("user_id", userId).maybeSingle(),
    db.from("trade_ledger").select(LEDGER_SELECT).eq("id", id).maybeSingle(),
  ]);
  if (owned.error || ledgerResult.error) throw new Error("Trade unavailable");
  if (!owned.data || !ledgerResult.data) return null;
  const trade = ledgerRow.parse(ledgerResult.data);
  const planned = trade.origin === "PLANNED";

  const [revisionsResult, plan, events, disposition, facts, unplannedClose, journal, evidence, relabels, removals, tagSets, legacyTags, lifecycle, activity] = await Promise.all([
    db.from("trade_revisions").select("proposal_id,revision,created_at").eq("trade_id", trade.id).eq("user_id", userId).order("revision", { ascending: true }),
    trade.plan_id
      ? db.from("trade_plans").select("id,proposal,risk_result,nominal_risk::text,locked_at,trading_day,account_observation_id,risk_plan_version_id,strategy_version_id,instrument_version_id")
        .eq("id", trade.plan_id).eq("user_id", userId).maybeSingle()
      : NONE,
    trade.plan_id
      ? db.from("trade_events").select("id,event_type,payload,occurred_at,recorded_at").eq("plan_id", trade.plan_id).eq("user_id", userId).order("sequence", { ascending: true }).limit(SOURCE_LIMIT)
      : EMPTY,
    trade.plan_id ? db.from("trade_dispositions").select("status,reason,recorded_at").eq("plan_id", trade.plan_id).eq("user_id", userId).maybeSingle() : NONE,
    planned
      ? EMPTY
      : db.from("trade_position_facts").select("id,recorded_at,source,instrument_version_id,symbol,direction,entry_model,entry_price::text,entered_at,quantity::text,initial_stop::text,risk_amount::text")
        .eq("trade_id", trade.id).eq("user_id", userId).order("recorded_at", { ascending: true }).order("id", { ascending: true }),
    planned ? NONE : db.from("trade_unplanned_closes").select("risk_basis::text,risk_basis_source").eq("trade_id", trade.id).eq("user_id", userId).maybeSingle(),
    db.from("trade_journal_entries").select("id,kind,body,details,phase,state_at_creation,source,recorded_at").eq("trade_id", trade.id).eq("user_id", userId)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).limit(SOURCE_LIMIT),
    db.from("trade_evidence").select("id,storage_path,label,timeframe,caption,original_filename,mime_type,byte_size,sha256,width,height,phase,state_at_creation,capture_method,copied_from,recorded_at")
      .eq("trade_id", trade.id).eq("user_id", userId).order("recorded_at", { ascending: true }).order("id", { ascending: true }),
    db.from("trade_evidence_labels").select("id,evidence_id,label,timeframe,caption,recorded_at").eq("trade_id", trade.id).eq("user_id", userId).order("id", { ascending: true }),
    db.from("trade_evidence_removals").select("evidence_id,recorded_at").eq("trade_id", trade.id).eq("user_id", userId),
    db.from("trade_tag_sets").select("id,setup_grade,liquidity_context,mss_timeframe,tags,recorded_at").eq("trade_id", trade.id).eq("user_id", userId).order("id", { ascending: true }),
    trade.plan_id
      ? db.from("trade_tag_revisions").select("id,setup_grade,liquidity_context,mss_timeframe,recorded_at").eq("plan_id", trade.plan_id).eq("user_id", userId).order("id", { ascending: true })
      : EMPTY,
    db.from("trade_lifecycle_events").select("id,event,reason,recorded_at").eq("trade_id", trade.id).eq("user_id", userId).order("recorded_at", { ascending: true }),
    loadAiActivity(db, [trade.id]),
  ]);
  const revisionRows = rows(revisionRow, revisionsResult, "Draft revisions");
  const planRecord = single(planRow, plan, "Locked plan");
  if (trade.plan_id && !planRecord) throw new Error("Locked plan unavailable");
  const proposalIds = revisionRows.map(row => row.proposal_id);

  const [proposals, checks, screenshots, screenshotRemovals, observation] = await Promise.all([
    proposalIds.length ? db.from("setup_proposals").select("id,proposal,created_at,instrument_version_id").eq("user_id", userId).in("id", proposalIds) : EMPTY,
    proposalIds.length
      ? db.from("setup_risk_checks").select("id,proposal_id,risk:risk_evaluations(id,result,recorded_at,risk_plan_version_id,instrument_version_id,strategy_version_id)")
        .eq("user_id", userId).in("proposal_id", proposalIds).order("id", { ascending: true }).limit(SOURCE_LIMIT)
      : EMPTY,
    proposalIds.length
      ? db.from("setup_screenshots").select("id,proposal_id,role,storage_path,original_filename,mime_type,byte_size,sha256,width,height,uploaded_at")
        .eq("user_id", userId).in("proposal_id", proposalIds).order("uploaded_at", { ascending: true }).order("id", { ascending: true })
      : EMPTY,
    proposalIds.length ? db.from("setup_screenshot_removals").select("screenshot_id,recorded_at").eq("user_id", userId).in("proposal_id", proposalIds) : EMPTY,
    planRecord ? db.from("account_observations").select("equity::text").eq("id", planRecord.account_observation_id).eq("user_id", userId).maybeSingle() : NONE,
  ]);
  const proposalRows = rows(proposalRow, proposals, "Draft revisions");
  const checkRows = rows(checkRow, checks, "Risk checks");
  const evidenceRows = rows(evidenceRow, evidence, "Evidence");
  const copiedIds = [...new Set(evidenceRows.map(row => row.copied_from).filter((value): value is string => value !== null))];

  const riskPlanIds = [...new Set([planRecord?.risk_plan_version_id, ...checkRows.map(row => row.risk.risk_plan_version_id)].filter((value): value is string => typeof value === "string"))];
  const instrumentIds = [...new Set([trade.instrument_version_id, planRecord?.instrument_version_id, ...checkRows.map(row => row.risk.instrument_version_id), ...proposalRows.map(row => row.instrument_version_id)]
    .filter((value): value is string => typeof value === "string"))];
  const strategyIds = [...new Set([planRecord?.strategy_version_id, ...checkRows.map(row => row.risk.strategy_version_id)].filter((value): value is string => typeof value === "string"))];
  const [riskPlans, instruments, strategies, copiedV2, copiedLegacy, aiHistory, aiAvailable] = await Promise.all([
    riskPlanIds.length ? db.from("risk_plan_versions").select(RISK_PLAN_SELECT).eq("user_id", userId).in("id", riskPlanIds) : EMPTY,
    instrumentIds.length ? db.from("instrument_versions").select(INSTRUMENT_SELECT).eq("user_id", userId).in("id", instrumentIds) : EMPTY,
    strategyIds.length ? db.from("strategy_versions").select("id,version").eq("user_id", userId).in("id", strategyIds) : EMPTY,
    copiedIds.length ? db.from("trade_evidence").select("id,recorded_at").eq("user_id", userId).in("id", copiedIds) : EMPTY,
    copiedIds.length ? db.from("setup_screenshots").select("id,uploaded_at").eq("user_id", userId).in("id", copiedIds) : EMPTY,
    deps.aiHistory(trade.id),
    deps.aiAvailable(trade.account_id, trade.lifecycle),
  ]);

  if (instruments.error) throw new Error("Instruments unavailable");
  const riskPlanById = new Map(rows(z.unknown(), riskPlans, "Risk plans").map(parseRiskPlanRow).map(riskPlan => [riskPlan.id, riskPlan] as const));
  const instrumentById = new Map(parseInstrumentRows(instruments.data).map(row => [row.id, toInstrument(row)] as const));
  const strategyById = new Map(rows(strategyNameRow, strategies, "Strategy versions").map(row => [row.id, row.version] as const));
  const copiedAt = new Map<string, string>([
    ...rows(z.object({ id: z.uuid(), recorded_at: instantText }), copiedV2, "Evidence").map(row => [row.id, row.recorded_at] as const),
    ...rows(z.object({ id: z.uuid(), uploaded_at: instantText }), copiedLegacy, "Evidence").map(row => [row.id, row.uploaded_at] as const),
  ]);
  const directory = accountDirectory(deps.accounts);
  const account = accountLabel(directory, trade);
  const proposalById = new Map(proposalRows.map(row => [row.id, row] as const));
  const revisionOf = new Map(revisionRows.map(row => [row.proposal_id, row.revision] as const));
  const instrument = trade.instrument_version_id ? instrumentById.get(trade.instrument_version_id) ?? null : null;

  // Explain each stored check with the immutable rows of its own risk plan and instrument versions (spec §6.5).
  const lookupFor = (riskPlanId: string | null, instrumentId: string | null, proposal: Record<string, unknown> | null, strategyId: string | null): ExplainLookup => {
    const riskPlan = riskPlanId ? riskPlanById.get(riskPlanId) : undefined;
    const contract = instrumentId ? instrumentById.get(instrumentId) : undefined;
    const fields = proposalFields.safeParse(proposal ?? {});
    return {
      riskPlan: riskPlan ? {
        id: riskPlan.id, maxRiskPercent: riskPlan.maxRiskPercent, minRR: riskPlan.minRR, dailyRiskCap: riskPlan.dailyRiskCap, dailyLossCap: riskPlan.dailyLossCap,
        rrPolicy: riskPlan.rrPolicy, newsPolicy: riskPlan.newsPolicy, maxDailyTrades: riskPlan.maxDailyTrades,
      } : undefined,
      instrument: contract ? {
        id: contract.id, symbol: contract.symbol, currency: contract.currency, tickSize: contract.tickSize, minimumQuantity: contract.minimumQuantity,
        quantityUnit: contract.quantityUnit, quantityStep: contract.quantityStep,
      } : undefined,
      proposal: fields.success ? { direction: fields.data.direction, riskPercent: fields.data.riskPercent } : undefined,
      strategy: strategyId ? strategyById.get(strategyId) : undefined,
      accountCurrency: account.currency,
    };
  };
  const checkLookups = new Map<string, ExplainLookup>();
  const checkViews: CheckView[] = [];
  const technicalChecks: TradeTechnical["checks"] = [];
  for (const row of checkRows) {
    const lookup = lookupFor(row.risk.risk_plan_version_id, row.risk.instrument_version_id ?? proposalById.get(row.proposal_id)?.instrument_version_id ?? null,
      proposalById.get(row.proposal_id)?.proposal ?? null, row.risk.strategy_version_id);
    checkLookups.set(row.risk.id, lookup);
    technicalChecks.push({ evaluationId: row.risk.id, recordedAt: row.risk.recorded_at, report: row.risk.result });
    const parsed = storedRiskSchema.safeParse(row.risk.result);
    if (parsed.success) checkViews.push(checkView(parsed.data, row.risk.recorded_at, revisionOf.get(row.proposal_id) ?? null, lookup));
  }
  const explainLookup: CheckExplainLookup = check => checkLookups.get(check.id);

  // Draft view and "Ready to lock" judgement (latest check of the latest revision, server time).
  const latestRevision = revisionRows[revisionRows.length - 1] ?? null;
  const latestCheckRow = trade.latest_check_evaluation_id ? checkRows.find(row => row.risk.id === trade.latest_check_evaluation_id) ?? null : null;
  const latestReport = latestCheckRow ? storedRiskSchema.safeParse(latestCheckRow.risk.result) : null;
  const latestCheck = latestCheckRow && latestReport?.success
    ? checkView(latestReport.data, latestCheckRow.risk.recorded_at, revisionOf.get(latestCheckRow.proposal_id) ?? null, checkLookups.get(latestCheckRow.risk.id) ?? {})
    : null;
  const current = await draftCheckCurrency(db, userId, [trade], directory, deps.now);
  const checkCurrent = current.get(trade.id) ?? false;
  const state = deriveTradeState(trade, {
    now: deps.now, checkCurrent, aiAvailable: aiAvailable, blockingReason: latestCheck?.decision === "BLOCKED" ? latestCheck.explained.blocking[0]?.detail : undefined,
  });
  const draft: DraftView | null = trade.lifecycle === "DRAFT" && latestRevision
    ? {
      revision: latestRevision.revision, expectedRevision: latestRevision.revision, createdAt: latestRevision.created_at,
      proposal: proposalView(proposalById.get(latestRevision.proposal_id)?.proposal ?? null, proposalById.get(latestRevision.proposal_id)?.instrument_version_id ?? null),
      latestCheck, checkCurrent,
    }
    : null;

  let planView: PlanView | null = null;
  if (planRecord) {
    const planReport = storedRiskSchema.safeParse(planRecord.risk_result);
    planView = {
      lockedAt: planRecord.locked_at, tradingDay: planRecord.trading_day,
      riskPlanVersion: riskPlanById.get(planRecord.risk_plan_version_id)?.version ?? trade.risk_plan_version,
      strategyVersion: strategyById.get(planRecord.strategy_version_id) ?? trade.strategy_version,
      proposal: proposalView(planRecord.proposal, planRecord.instrument_version_id),
      check: planReport.success
        ? checkView(planReport.data, planRecord.locked_at, null, lookupFor(planRecord.risk_plan_version_id, planRecord.instrument_version_id, planRecord.proposal, planRecord.strategy_version_id))
        : null,
      nominalRisk: stripZeros(planRecord.nominal_risk),
      immutableNote: state.immutableNote ?? "Locked plans can't be edited. Later changes are recorded in the journal.",
    };
  }

  const hasEntry = trade.origin !== "PLANNED" || trade.entry_recorded_at !== null;
  const execution: ExecutionView | null = hasEntry
    ? {
      entryPrice: trade.entry_price, enteredAt: trade.entered_at, recordedAt: trade.entry_recorded_at, quantity: trade.quantity, plannedQuantity: trade.planned_quantity,
      oversize: trade.oversize === true, initialStop: trade.initial_stop, initialRisk: trade.initial_risk, actualRisk: trade.actual_initial_risk,
    }
    : null;
  const closeRecord = single(unplannedCloseRow, unplannedClose, "Close");
  const close: CloseView | null = trade.exited_at !== null
    ? {
      exitPrice: trade.exit_price, exitedAt: trade.exited_at, recordedAt: trade.close_recorded_at, fees: trade.fees, grossPnl: trade.gross_pnl, netPnl: trade.net_pnl,
      realizedR: trade.realized_r, outcome: trade.outcome, pnlSource: trade.pnl_source, riskBasisSource: closeRecord?.risk_basis_source ?? null,
      basisLabel: basisLabel(trade),
    }
    : null;
  const dispositionRecord = single(dispositionRow, disposition, "Disposition");
  const observationEquity = planRecord ? single(z.object({ equity: decimalText }), observation, "Account values")?.equity ?? null : null;
  const planRisk = planRecord ? riskPlanById.get(planRecord.risk_plan_version_id) : undefined;

  // Evidence: V2 items with their latest relabel, legacy screenshots of the revisions; timing per spec §5.3.
  const relabelRows = rows(relabelRow, relabels, "Evidence labels");
  const latestLabel = new Map(relabelRows.map(row => [row.evidence_id, row] as const));
  const removedAt = new Map<string, string>([
    ...rows(removalRow, removals, "Evidence").map(row => [row.evidence_id, row.recorded_at] as const),
    ...rows(screenshotRemovalRow, screenshotRemovals, "Evidence").map(row => [row.screenshot_id, row.recorded_at] as const),
  ]);
  const entryRecordedAt = trade.entry_recorded_at ?? (planned ? null : trade.created_at);
  const timingOf = (recordedAt: string, storedPhase: StoredPhase | null) => classifyTiming({
    recordedAt, storedPhase: storedPhase ?? inferStoredPhase(recordedAt, entryRecordedAt, trade.close_recorded_at), origin: trade.origin,
    entryAt: trade.entered_at, entryRecordedAt, exitAt: trade.exited_at, tradeCreatedAt: trade.created_at,
  });
  const flagWords = (flags: readonly TimingFlag[]) => flags.map(flag => TIMING_FLAG_COPY[flag]);
  const screenshotRows = rows(screenshotRow, screenshots, "Screenshots");
  const items: EvidenceItemView[] = [
    ...evidenceRows.map(row => {
      const label = latestLabel.get(row.id) ?? row;
      const timing = timingOf(row.recorded_at, row.phase);
      const removed = removedAt.get(row.id) ?? null;
      return {
        ...evidenceSource("V2", row.id), id: row.id, name: evidenceName(label.label, label.timeframe), label: label.label, timeframe: label.timeframe, caption: label.caption,
        timing: timing.timing, timingLabel: TIMING_LABELS[timing.timing], flags: flagWords(timing.flags), recordedAt: row.recorded_at, removedAt: removed,
        copiedFromRecordedAt: row.copied_from ? copiedAt.get(row.copied_from) ?? null : null, copied: row.capture_method === "DUPLICATE",
        originalFilename: row.original_filename, mimeType: row.mime_type, width: row.width, height: row.height, byteSize: row.byte_size,
        relabelable: removed === null, removable: removed === null,
      };
    }),
    ...screenshotRows.map(row => {
      const timing = timingOf(row.uploaded_at, null);
      const removed = removedAt.get(row.id) ?? null;
      const label = legacyEvidenceLabel(row.role);
      return {
        ...evidenceSource("LEGACY", row.id), id: row.id, name: evidenceName(label, row.role), label, timeframe: row.role, caption: null,
        timing: timing.timing, timingLabel: TIMING_LABELS[timing.timing], flags: flagWords(timing.flags), recordedAt: row.uploaded_at, removedAt: removed,
        copiedFromRecordedAt: null, copied: false, originalFilename: row.original_filename, mimeType: row.mime_type, width: row.width, height: row.height,
        byteSize: row.byte_size, relabelable: false, removable: removed === null,
      };
    }),
  ].sort((a, b) => (instantMicros(a.recordedAt) < instantMicros(b.recordedAt) ? -1 : instantMicros(a.recordedAt) > instantMicros(b.recordedAt) ? 1 : a.id < b.id ? -1 : 1));
  const active = items.filter(item => item.removedAt === null);
  const evidenceGroups: EvidenceGroup[] = (["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"] as const).map(timing => ({
    timing, label: TIMING_LABELS[timing], items: active.filter(item => item.timing === timing),
  }));
  const timelineEvidence: TimelineEvidence[] = [
    ...evidenceRows.map(row => {
      const label = latestLabel.get(row.id) ?? row;
      return { kind: "V2" as const, id: row.id, label: label.label, timeframe: label.timeframe, caption: label.caption, phase: row.phase, recordedAt: row.recorded_at, removedAt: removedAt.get(row.id) ?? null };
    }),
    ...screenshotRows.map(row => ({ kind: "LEGACY" as const, id: row.id, role: row.role, recordedAt: row.uploaded_at, removedAt: removedAt.get(row.id) ?? null })),
  ];

  // Timeline (spec §5.4).
  const eventRows = rows(eventRow, events, "Trade events");
  const journalRows = rows(journalRow, journal, "Journal entries");
  const tagSetRows = rows(tagSetRow, tagSets, "Tags");
  const legacyTagRows = rows(tagSetRow.omit({ tags: true }), legacyTags, "Tags");
  const lifecycleRows = rows(lifecycleRow, lifecycle, "Review history");
  const aiAnalyses: TimelineAiAnalysis[] = aiHistory ? timelineAiAnalyses([...aiHistory.preTrade.flatMap(group => group.rows), ...aiHistory.reviews]) : [];
  const timeline = buildTimeline({
    trade,
    instrument: instrument ? { tickSize: instrument.tickSize, quantityStep: instrument.quantityStep, quantityUnit: instrument.quantityUnit } : null,
    revisions: revisionRows.map(row => ({ proposalId: row.proposal_id, revision: row.revision, createdAt: row.created_at })),
    riskChecks: checkRows.map(row => ({ id: row.risk.id, recordedAt: row.risk.recorded_at, decision: storedDecision(row.risk.result), result: row.risk.result, proposalId: row.proposal_id })),
    legacyEvents: eventRows.map(row => ({ id: row.id, eventType: row.event_type, payload: row.payload, occurredAt: row.occurred_at, recordedAt: row.recorded_at })),
    journal: journalRows.map(row => ({ id: row.id, kind: row.kind, body: row.body, details: row.details, phase: row.phase, recordedAt: row.recorded_at })),
    evidence: timelineEvidence,
    tagSets: [
      ...legacyTagRows.map(row => ({ id: String(row.id), source: "V1" as const, recordedAt: row.recorded_at, setupGrade: row.setup_grade, liquidityContext: row.liquidity_context, mssTimeframe: row.mss_timeframe })),
      ...tagSetRows.map(row => ({ id: String(row.id), source: "V2" as const, recordedAt: row.recorded_at, setupGrade: row.setup_grade, liquidityContext: row.liquidity_context, mssTimeframe: row.mss_timeframe, tags: row.tags ?? [] })),
    ],
    disposition: dispositionRecord ? { status: dispositionRecord.status, reason: dispositionRecord.reason, recordedAt: dispositionRecord.recorded_at } : null,
    aiAnalyses,
    lifecycleEvents: lifecycleRows.map(row => ({ id: row.id, event: row.event, reason: row.reason, recordedAt: row.recorded_at })),
    explainLookup,
  }, deps.display);

  const factRows = rows(factsRow, facts, "Entry details");
  const truncated = [eventRows, journalRows, checkRows].some(list => list.length >= SOURCE_LIMIT);
  return {
    tradeId: trade.id,
    href: `/trades/${trade.id}`,
    account,
    origin: trade.origin,
    title: titleOf(trade),
    symbol: trade.symbol,
    direction: trade.direction,
    model: trade.entry_model,
    createdAt: trade.created_at,
    duplicatedFromHref: trade.duplicated_from ? `/trades/${trade.duplicated_from}` : null,
    state,
    revisionCount: trade.revision_count,
    draft,
    plan: planView,
    execution,
    close,
    disposition: dispositionRecord ? { status: dispositionRecord.status, reason: dispositionRecord.reason, recordedAt: dispositionRecord.recorded_at } : null,
    planVsReality: planVsReality(trade, instrument ? { tickSize: instrument.tickSize, pipSize: instrument.pipSize, quantityStep: instrument.quantityStep, quantityUnit: instrument.quantityUnit } : null, {
      equity: observationEquity, maxRiskPercent: planRisk?.maxRiskPercent ?? null, minRR: planRisk?.minRR ?? null,
    }),
    positionFacts: factRows.map(row => ({ recordedAt: row.recorded_at, source: row.source, facts: factWords(row) })),
    instrument: instrument ? { symbol: instrument.symbol, currency: instrument.currency, quantityUnit: instrument.quantityUnit, tickSize: instrument.tickSize, pipSize: instrument.pipSize, tickValue: instrument.tickValue, quantityStep: instrument.quantityStep, minimumQuantity: instrument.minimumQuantity } : null,
    tags: { grade: trade.setup_grade, liquidity: trade.liquidity_context, mss: trade.mss_timeframe, tags: trade.tags, source: trade.tag_source },
    checks: checkViews,
    timeline,
    timelineGroups: groupByTiming(timeline),
    timelineTruncated: truncated,
    evidence: { items, groups: evidenceGroups, activeCount: active.length, limit: EVIDENCE_LIMIT },
    evidenceIndex: Object.fromEntries(items.map(item => [item.id, { label: item.label, timeframe: item.timeframe }])),
    review: { completedAt: trade.review_completed_at },
    ai: { activity: activity.get(trade.id) ?? NO_ACTIVITY, history: aiHistory, available: aiAvailable },
    technical: {
      tradeId: trade.id, accountId: trade.account_id, origin: trade.origin, planId: trade.plan_id, latestProposalId: trade.latest_proposal_id, proposalIds,
      latestCheckEvaluationId: trade.latest_check_evaluation_id, strategyVersionId: trade.strategy_version_id, riskPlanVersionId: trade.risk_plan_version_id,
      instrumentVersionId: trade.instrument_version_id, duplicatedFrom: trade.duplicated_from, migratedFrom: trade.migrated_from, checks: technicalChecks,
      planReport: planRecord?.risk_result ?? null,
      evidence: [
        ...evidenceRows.map(row => ({ id: row.id, kind: "V2" as const, sha256: row.sha256, storagePath: row.storage_path, captureMethod: row.capture_method, copiedFrom: row.copied_from, storedPhase: row.phase, stateAtCreation: row.state_at_creation })),
        ...screenshotRows.map(row => ({ id: row.id, kind: "LEGACY" as const, sha256: row.sha256, storagePath: row.storage_path, captureMethod: null, copiedFrom: null, storedPhase: null, stateAtCreation: null })),
      ],
      ledger: trade,
    },
  };
}

const AI_OPERATION_BY_LIFECYCLE: Partial<Record<Lifecycle, string>> = { DRAFT: "ANALYZE_SETUP", CLOSED: "REVIEW_TRADE_TIMELINE", REVIEWED: "REVIEW_TRADE_TIMELINE" };

/** The trade workspace of the signed-in user, or null when the trade is not theirs (pages call notFound()). */
export const getTradeDetail = cache(async (tradeId: string): Promise<TradeDetail | null> => {
  const [{ db, user }, context, preferences] = await Promise.all([currentSession(), getAccountContext(), getPreferences()]);
  return loadTradeDetail({
    db, userId: user.id, accounts: context.accounts, now: new Date().toISOString(), display: preferences.timeDisplay,
    aiAvailable: async (accountId, lifecycle) => {
      const operation = AI_OPERATION_BY_LIFECYCLE[lifecycle];
      if (!operation) return false;
      try {
        return (await accountAiAvailability(accountId, operation)).status === "ENABLED";
      } catch {
        return false;
      }
    },
    aiHistory: async id => {
      const history = await loadTradeAiHistory(id);
      return history.error ? null : history;
    },
  }, tradeId);
});
