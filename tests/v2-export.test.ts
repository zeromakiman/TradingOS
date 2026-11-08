import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { LEDGER_COLUMNS } from "@/domain/ledger";
import { createTestDatabase } from "./helpers/pglite";

// docs/V2_ARCHITECTURE.md §10.5: GET /api/export reads every part with the user's own session (RLS), in keyset order
// over each table's real key, with NUMERIC columns as exact strings; the trades CSV is formula-injection guarded.

const mock = vi.hoisted(() => ({ client: null as unknown, trustedServer: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => mock.client }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: mock.trustedServer }));

import { GET } from "@/app/api/export/route";
import { csvCell, EXPORT_TABLES, type EvidenceManifestItem, type ExportDocument, encodeCursor } from "@/lib/export";

const UID = "10000000-0000-4000-8000-000000000001";
const EMAIL = "trader@example.test";
const NOW = "2026-10-17T12:00:00.000Z";

type Row = Record<string, unknown>;
interface Call { table: string; select: string; order: string[]; gt: [string, string] | null; or: string | null; in: [string, string[]] | null; eq: [string, string] | null; limit: number }

/** PostgREST over in-memory rows of the signed-in user: `*` sends NUMERIC columns as (lossy) JSON numbers. */
class FakePostgrest {
  readonly calls: Call[] = [];
  readonly failing = new Set<string>();
  /** Server-side max-rows: a response never holds more rows than this, whatever the request's limit. */
  maxRows = Number.POSITIVE_INFINITY;
  readonly auth = { getUser: vi.fn(async () => ({ data: { user: { id: UID, email: EMAIL } }, error: null })) };
  readonly rpc = vi.fn();

  constructor(readonly tables: Record<string, { rows: Row[]; numeric?: string[] }> = {}) {}

  from(table: string) {
    const call: Call = { table, select: "", order: [], gt: null, or: null, in: null, eq: null, limit: Number.POSITIVE_INFINITY };
    this.calls.push(call);
    const builder = {
      select: (columns: string) => { call.select = columns; return builder; },
      in: (column: string, values: readonly unknown[]) => { call.in = [column, values.map(String)]; return builder; },
      eq: (column: string, value: unknown) => { call.eq = [column, String(value)]; return builder; },
      order: (column: string, options: { ascending: boolean }) => {
        if (!options.ascending) throw new Error("Keyset reads must be ascending.");
        call.order.push(column);
        return builder;
      },
      gt: (column: string, value: string | number) => { call.gt = [column, String(value)]; return builder; },
      or: (filter: string) => { call.or = filter; return builder; },
      limit: (count: number) => { call.limit = count; return Promise.resolve(this.run(call)); },
    };
    return builder;
  }

  private run(call: Call): { data: Row[] | null; error: { message: string } | null } {
    if (this.failing.has(call.table)) return { data: null, error: { message: "permission denied for relation internal_detail_42" } };
    const source = this.tables[call.table] ?? { rows: [] };
    const numeric = new Set(source.numeric ?? []);
    let rows = [...source.rows];
    if (call.gt) {
      const [column, value] = call.gt;
      rows = rows.filter((row) => compare(row[column], value) > 0);
    }
    if (call.or) rows = rows.filter((row) => matchesOr(row, call.or as string));
    if (call.in) {
      const [column, values] = call.in;
      rows = rows.filter((row) => values.includes(String(row[column])));
    }
    if (call.eq) {
      const [column, value] = call.eq;
      rows = rows.filter((row) => String(row[column]) === value);
    }
    rows.sort((a, b) => {
      for (const column of call.order) {
        const order = compare(a[column], b[column]);
        if (order !== 0) return order;
      }
      return 0;
    });
    rows = rows.slice(0, Math.min(call.limit, this.maxRows));
    return { data: rows.map((row) => project(row, call.select, numeric)), error: null };
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof b === "number") return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    current += character;
  }
  return [...parts, current];
}

function matchesCondition(row: Row, condition: string): boolean {
  const [column, operator, ...rest] = condition.split(".");
  const value = rest.join(".");
  if (operator === "eq") return compare(row[column], value) === 0;
  if (operator === "gt") return compare(row[column], value) > 0;
  throw new Error(`Unsupported filter ${condition}`);
}

function matchesOr(row: Row, filter: string): boolean {
  return splitTopLevel(filter).some((term) => term.startsWith("and(")
    ? splitTopLevel(term.slice(4, -1)).every((condition) => matchesCondition(row, condition))
    : matchesCondition(row, term));
}

function project(row: Row, select: string, numeric: Set<string>): Row {
  const lossy = (column: string) => (numeric.has(column) && row[column] !== null ? Number(row[column]) : row[column]);
  const result: Row = {};
  for (const item of select.split(",")) {
    if (item === "*") {
      for (const column of Object.keys(row)) result[column] = lossy(column);
      continue;
    }
    const cast = /^(?:(\w+):)?(\w+)::text$/.exec(item);
    if (cast) {
      result[cast[1] ?? cast[2]] = row[cast[2]] === null ? null : String(row[cast[2]]);
      continue;
    }
    result[item] = lossy(item);
  }
  return result;
}

const uuids = (count: number) => Array.from({ length: count }, () => randomUUID());
const sortedById = (rows: readonly Row[]) => [...rows].sort((a, b) => compare(a.id, b.id));
const exportRequest = (query: string) => new Request(`http://localhost/api/export?${query}`);
async function exportJson(query: string): Promise<{ response: Response; document: ExportDocument }> {
  const response = await GET(exportRequest(query));
  return { response, document: (await response.json()) as ExportDocument };
}

/** The ledger columns the manifest's timing reads (`planEndedAt` included), as the view returns them. */
const LEDGER_TIMING_SELECT = "id,origin,created_at,entered_at,entry_recorded_at,entry_price::text,exited_at,close_recorded_at,outcome,plan_id,lifecycle,disposition,legacy_decision,discarded_at";
const ledgerTiming = (changes: Row): Row => ({
  origin: "PLANNED", entered_at: null, entry_recorded_at: null, entry_price: null, exited_at: null, close_recorded_at: null, outcome: null, plan_id: null,
  lifecycle: "DRAFT", disposition: null, legacy_decision: null, discarded_at: null, user_id: UID, ...changes,
});

let client: FakePostgrest;
let log: MockInstance;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  client = new FakePostgrest();
  mock.client = client;
  mock.trustedServer.mockImplementation(() => { throw new Error("The export must never use the secret key."); });
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  log.mockRestore();
  expect(mock.trustedServer).not.toHaveBeenCalled();
  expect(client.rpc).not.toHaveBeenCalled();
});

describe("GET /api/export", () => {
  it("exports a JSON part with the user's session only, exact NUMERIC strings and download headers", async () => {
    client = new FakePostgrest({
      account_observations: {
        numeric: ["equity", "balance", "gross_loss_today"],
        rows: [{ id: randomUUID(), user_id: UID, equity: "10000.10", balance: "0.100000000000000000000000000001", gross_loss_today: null, recorded_at: NOW }],
      },
      risk_plan_versions: {
        numeric: ["max_risk_percent", "default_risk_percent", "min_rr", "daily_risk_cap", "daily_loss_cap"],
        rows: [{ id: randomUUID(), user_id: UID, version: "Risk Plan V1.0", max_risk_percent: "0.50000000", default_risk_percent: null, min_rr: "3.00000000", daily_risk_cap: "123456789012.99", daily_loss_cap: null, max_daily_trades: 2 }],
      },
    });
    mock.client = client;
    const { response, document } = await exportJson("part=core");
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="trading-os-core-2026-10-17.json"',
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(Object.keys(document)).toEqual(["exportedAt", "schema", "part", "user", "tables"]);
    expect(document).toMatchObject({ exportedAt: NOW, schema: "2.0", part: "core", user: { id: UID, email: EMAIL } });
    expect(Object.keys(document.tables)).toEqual(EXPORT_TABLES.core.map((table) => table.name));
    expect(document.tables.account_observations).toEqual([client.tables.account_observations.rows[0]]);
    expect(document.tables.risk_plan_versions[0]).toEqual({ ...client.tables.risk_plan_versions.rows[0], max_daily_trades: 2 });
    expect(new Set(client.calls.map((call) => call.table))).toEqual(new Set(EXPORT_TABLES.core.map((table) => table.name)));
    expect(client.calls.find((call) => call.table === "account_observations")?.select)
      .toBe("*,equity__exact:equity::text,balance__exact:balance::text,gross_loss_today__exact:gross_loss_today::text");
  });

  it.each(["trades", "ai", "evidence-manifest"] as const)("returns every table of the %s part", async (part) => {
    const { response, document } = await exportJson(`part=${part}`);
    expect(response.status).toBe(200);
    expect(Object.keys(document.tables)).toEqual(EXPORT_TABLES[part].map((table) => table.name));
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="trading-os-${part}-2026-10-17.json"`);
  });

  it("pages through every row exactly once in key order, also when the server caps responses below the page size", async () => {
    const trades = uuids(2345).map((id) => ({ id, user_id: UID, origin: "PLANNED" }));
    client = new FakePostgrest({ trades: { rows: trades } });
    mock.client = client;
    const { document } = await exportJson("part=trades");
    expect(document.tables.trades).toEqual(sortedById(trades));
    const reads = client.calls.filter((call) => call.table === "trades");
    expect(reads.map((call) => [call.limit, call.gt === null])).toEqual([[1000, true], [1000, false], [1000, false], [1000, false]]);
    expect(reads.every((call) => call.order.join() === "id")).toBe(true);

    client = new FakePostgrest({ trades: { rows: trades } });
    client.maxRows = 300;
    mock.client = client;
    const capped = (await exportJson("part=trades")).document;
    expect(capped.tables.trades).toHaveLength(2345);
    expect(capped.tables.trades).toEqual(sortedById(trades));
    expect(client.calls.filter((call) => call.table === "trades")).toHaveLength(Math.ceil(2345 / 300) + 1);
  });

  it("uses composite and integer keys: (evaluation, screenshot) tuples and identity ids", async () => {
    const evaluations = uuids(3);
    const pairs = evaluations.flatMap((evaluation) => uuids(700).map((screenshot) => ({ evaluation_id: evaluation, screenshot_id: screenshot, user_id: UID })));
    const events = Array.from({ length: 1500 }, (_, i) => ({ id: 1500 - i, user_id: UID, status: "RUNNING" }));
    client = new FakePostgrest({ setup_evaluation_screenshots: { rows: pairs }, setup_evaluation_events: { rows: events } });
    mock.client = client;
    const { document } = await exportJson("part=ai");
    const byPair = (a: Row, b: Row) => compare(a.evaluation_id, b.evaluation_id) || compare(a.screenshot_id, b.screenshot_id);
    expect(document.tables.setup_evaluation_screenshots).toEqual([...pairs].sort(byPair));
    expect(document.tables.setup_evaluation_events.map((row) => row.id)).toEqual(Array.from({ length: 1500 }, (_, i) => i + 1));
    const composite = client.calls.filter((call) => call.table === "setup_evaluation_screenshots");
    expect(composite[0]).toMatchObject({ order: ["evaluation_id", "screenshot_id"], or: null });
    const last = [...pairs].sort(byPair)[999];
    expect(composite[1].or).toBe(`evaluation_id.gt.${last.evaluation_id},and(evaluation_id.eq.${last.evaluation_id},screenshot_id.gt.${last.screenshot_id})`);
    expect(client.calls.find((call) => call.table === "setup_evaluation_events" && call.gt)?.gt).toEqual(["id", "1000"]);
  });

  it("fails closed when keyset pagination does not advance instead of looping or duplicating rows", async () => {
    client = new FakePostgrest({ trades: { rows: uuids(3).map((id) => ({ id, user_id: UID })) } });
    client.from = ((table: string) => {
      const rows = table === "trades" ? client.tables.trades.rows : [];
      const builder = {
        select: () => builder, in: () => builder, eq: () => builder, order: () => builder, gt: () => builder, or: () => builder, limit: async () => ({ data: rows, error: null }),
      };
      return builder;
    }) as FakePostgrest["from"];
    mock.client = client;
    const response = await GET(exportRequest("part=trades"));
    expect(response.status).toBe(503);
  });

  it("serves one table page by page with a cursor, within the response budget", async () => {
    const big = "x".repeat(100_000);
    const rows = uuids(70).map((id) => ({ id, user_id: UID, facts: { blob: big } }));
    client = new FakePostgrest({ bias_challenges: { rows } });
    mock.client = client;
    const pages: Row[][] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const { response, document }: { response: Response; document: ExportDocument } =
        await exportJson(`part=ai&table=bias_challenges${after ? `&after=${after}` : ""}`);
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="trading-os-ai-bias_challenges-2026-10-17.json"');
      expect(Object.keys(document.tables)).toEqual(["bias_challenges"]);
      pages.push(document.tables.bias_challenges);
      expect(JSON.stringify(document).length).toBeLessThan(4 * 1024 * 1024);
      after = document.next ?? null;
      if (!after) break;
    }
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flat()).toEqual(sortedById(rows));
  });

  it("exports the trade ledger as a guarded CSV, one row per trade by creation time", async () => {
    const base = Object.fromEntries(LEDGER_COLUMNS.map((column) => [column, null])) as Row;
    const first = { ...base, id: "00000000-0000-4000-8000-000000000002", created_at: "2026-10-01T09:00:00+00:00", symbol: "EURUSD", net_pnl: "-12.5", realized_r: "-1", tags: ["a-grade", "news"], oversize: false, disposition_reason: '=HYPERLINK("http://evil.example")' };
    const second = { ...base, id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-02T09:00:00+00:00", symbol: "-cmd|' /C calc'!A0", net_pnl: "3.4", disposition_reason: "@SUM(1+1)", entry_model: "+1", currency: "\tUSD" };
    client = new FakePostgrest({ trade_ledger: { rows: [second, first] } });
    mock.client = client;
    const response = await GET(exportRequest("part=trades-csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="trading-os-trades-2026-10-17.csv"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
    expect(body.startsWith("﻿")).toBe(true);
    const lines = body.slice(1).split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(LEDGER_COLUMNS.join(","));
    expect(lines[3]).toBe("");
    const cells = (line: string) => Object.fromEntries(LEDGER_COLUMNS.map((column, i) => [column, line.split(/,(?=")/)[i]]));
    expect(cells(lines[1])).toMatchObject({ id: '"00000000-0000-4000-8000-000000000002"', net_pnl: '"-12.5"', realized_r: '"-1"', tags: '"a-grade; news"', oversize: '"false"', disposition_reason: `"'=HYPERLINK(""http://evil.example"")"` });
    expect(cells(lines[2])).toMatchObject({ symbol: `"'-cmd|' /C calc'!A0"`, disposition_reason: `"'@SUM(1+1)"`, entry_model: `"'+1"`, currency: `"'\tUSD"`, net_pnl: '"3.4"', exit_price: '""' });
    expect(client.calls.find((call) => call.table === "trade_ledger")?.select).toBe(LEDGER_COLUMNS.join(","));
  });

  it("reads the trades CSV one account at a time, never as a keyset over every account's ledger", async () => {
    // The ledger derives most columns per row: a page over every account computes every remaining trade of the user
    // before it can sort by id (19,900 trades: 29-43 s; 45,000: past the statement timeout). One account's pages do not.
    const base = Object.fromEntries(LEDGER_COLUMNS.map((column) => [column, null])) as Row;
    const accounts = ["20000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000001"];
    const ids = uuids(2500);
    const ledger = ids.map((id, index) => ({ ...base, id, account_id: accounts[index % 2], created_at: `2026-10-01T09:${String(index % 60).padStart(2, "0")}:00.${String(index).padStart(6, "0")}+00:00` }));
    client = new FakePostgrest({ accounts: { rows: accounts.map((id) => ({ id, user_id: UID })) }, trade_ledger: { rows: ledger } });
    mock.client = client;
    const response = await GET(exportRequest("part=trades-csv"));
    const lines = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer()).slice(1).split(/\r\n/);
    expect(lines.slice(1, -1).map((line) => line.split(",")[0].replaceAll('"', ""))).toEqual(
      [...ledger].sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : String(a.id) < String(b.id) ? -1 : 1)).map((row) => row.id),
    );
    const reads = client.calls.filter((call) => call.table === "trade_ledger");
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.every((call) => call.eq !== null && call.eq[0] === "account_id" && accounts.includes(call.eq[1]))).toBe(true);
  });

  it.each([
    ["", "Unknown export part."],
    ["part=everything", "Unknown export part."],
    ["part=CORE", "Unknown export part."],
    ["part=core&table=trades", "Unknown export table."],
    ["part=core&after=abc", "A cursor needs a table."],
    ["part=trades-csv&table=trades", "The trades CSV is exported whole."],
    ["part=trades&table=trades&after=not-a-cursor", "Invalid export cursor."],
    [`part=trades&table=trades&after=${encodeCursor(["a", "b"])}`, "Invalid export cursor."],
    [`part=trades&table=trades&after=${encodeCursor(["x' or 1=1"])}`, "Invalid export cursor."],
    [`part=trades&table=accounts&after=${encodeCursor([randomUUID()])}`, "Unknown export table."],
  ])("rejects %j with 400 before reading anything", async (query, message) => {
    const response = await GET(exportRequest(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(client.calls).toEqual([]);
  });

  it("answers 401 without a session and 503 during a sign-in outage, reading nothing", async () => {
    client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null } as never);
    expect((await GET(exportRequest("part=core"))).status).toBe(401);
    client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 503, message: "upstream" } } as never);
    expect((await GET(exportRequest("part=core"))).status).toBe(503);
    expect(client.calls).toEqual([]);
  });

  it("turns any read failure into a fixed 503 without leaking database details", async () => {
    client.failing.add("ai_usage_records");
    const response = await GET(exportRequest("part=ai"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "Your data could not be exported right now. Nothing was changed; please try again." });
    expect(body).not.toMatch(/internal_detail|permission/);
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([JSON.stringify({ event: "request_failed", status: 503 })]);
  });
});

describe("evidence manifest", () => {
  it("lists every V2 and legacy image with its effective label, timing band, removal and owner-only download route", async () => {
    const [planned, liveFirst, evidenceBefore, evidenceAfter, evidenceLive, legacyBefore, legacyOrphan, proposal, orphanProposal] = uuids(9);
    const image = { original_filename: "chart.png", mime_type: "image/png", byte_size: 2048, width: 1280, height: 720, sha256: "a".repeat(64) };
    const v2 = (id: string, tradeId: string, phase: string, recordedAt: string, label: string) => ({
      id, user_id: UID, trade_id: tradeId, storage_path: `${UID}/${tradeId}/${id}`, label, timeframe: "M5", caption: null, ...image,
      phase, state_at_creation: "DRAFT", capture_method: "PASTE", copied_from: null, recorded_at: recordedAt,
    });
    client = new FakePostgrest({
      trade_evidence: { rows: [
        v2(evidenceBefore, planned, "PRE_ENTRY", "2026-10-14T08:00:00+00:00", "PRE_ENTRY"),
        v2(evidenceAfter, planned, "POST_TRADE", "2026-10-14T11:00:00+00:00", "EXIT"),
        v2(evidenceLive, liveFirst, "PRE_ENTRY", "2026-10-15T10:00:00+00:00", "ENTRY"),
      ] },
      trade_evidence_labels: { rows: [
        { id: 1, evidence_id: evidenceBefore, user_id: UID, label: "CONTEXT", timeframe: null, caption: "First relabel", recorded_at: "2026-10-14T08:10:00+00:00" },
        { id: 2, evidence_id: evidenceBefore, user_id: UID, label: "HTF", timeframe: "H4", caption: "Latest relabel", recorded_at: "2026-10-14T08:20:00+00:00" },
      ] },
      trade_evidence_removals: { rows: [{ evidence_id: evidenceAfter, user_id: UID, recorded_at: "2026-10-14T12:00:00+00:00" }] },
      setup_screenshots: { rows: [
        { id: legacyBefore, user_id: UID, proposal_id: proposal, role: "H4", storage_path: `${UID}/${proposal}/${legacyBefore}`, ...image, uploaded_at: "2026-10-14T07:00:00+00:00" },
        { id: legacyOrphan, user_id: UID, proposal_id: orphanProposal, role: "M5", storage_path: `${UID}/${orphanProposal}/${legacyOrphan}`, ...image, uploaded_at: "2026-10-16T07:00:00+00:00" },
      ] },
      setup_screenshot_removals: { rows: [{ screenshot_id: legacyOrphan, user_id: UID, proposal_id: orphanProposal, recorded_at: "2026-10-16T08:00:00+00:00" }] },
      trade_revisions: { rows: [{ proposal_id: proposal, trade_id: planned, revision: 1, user_id: UID }] },
      trade_ledger: { numeric: ["entry_price"], rows: [
        ledgerTiming({ id: planned, created_at: "2026-10-14T06:00:00+00:00", entered_at: "2026-10-14T09:00:00+00:00", entry_price: "1.10005",
          entry_recorded_at: "2026-10-14T09:01:00+00:00", exited_at: "2026-10-14T10:30:00+00:00", close_recorded_at: "2026-10-14T10:31:00+00:00",
          outcome: "WIN", plan_id: randomUUID(), lifecycle: "CLOSED" }),
        ledgerTiming({ id: liveFirst, origin: "LIVE_FIRST", created_at: "2026-10-15T09:55:00+00:00", entry_recorded_at: "2026-10-15T09:55:00+00:00", lifecycle: "LIVE" }),
      ] },
    });
    mock.client = client;
    const { document } = await exportJson("part=evidence-manifest");
    expect(Object.keys(document)).toEqual(["exportedAt", "schema", "part", "user", "tables", "manifest"]);
    expect(document.tables.trade_evidence).toHaveLength(3);
    const byId = Object.fromEntries((document.manifest ?? []).map((item) => [item.id, item]));
    expect(document.manifest?.map((item) => item.id)).toEqual([legacyBefore, evidenceBefore, evidenceAfter, evidenceLive, legacyOrphan]);
    expect(byId[evidenceBefore]).toEqual({
      id: evidenceBefore, kind: "V2", tradeId: planned, proposalId: null, label: "HTF", role: null, timeframe: "H4", caption: "Latest relabel",
      originalFilename: "chart.png", mimeType: "image/png", byteSize: 2048, width: 1280, height: 720, sha256: "a".repeat(64),
      recordedAt: "2026-10-14T08:00:00+00:00", timing: "BEFORE_ENTRY", removedAt: null, captureMethod: "PASTE", copiedFrom: null,
      downloadPath: `/api/evidence/${evidenceBefore}`,
    });
    expect(byId[evidenceAfter]).toMatchObject({ label: "EXIT", timing: "AFTER_CLOSE", removedAt: "2026-10-14T12:00:00+00:00" });
    // Live-first trades are open from creation: never pre-entry evidence, whatever the stored phase says.
    expect(byId[evidenceLive]).toMatchObject({ timing: "WHILE_LIVE", tradeId: liveFirst });
    expect(byId[legacyBefore]).toMatchObject({
      kind: "LEGACY", tradeId: planned, proposalId: proposal, label: "HTF", role: "H4", timeframe: "H4", caption: null,
      timing: "BEFORE_ENTRY", removedAt: null, downloadPath: `/api/screenshots/${legacyBefore}`, recordedAt: "2026-10-14T07:00:00+00:00",
    });
    expect(byId[legacyOrphan]).toMatchObject({ tradeId: null, label: "OTHER", timing: null, removedAt: "2026-10-16T08:00:00+00:00" });
    // NUMERIC entry prices are read as text (PostgREST sends NUMERIC as a lossy JSON number).
    expect(client.calls.find((call) => call.table === "trade_ledger")?.select).toBe(LEDGER_TIMING_SELECT);
    // No plan here ended without an entry: nothing else is read to date one.
    expect(client.calls.some((call) => call.table === "trade_dispositions" || call.table === "setup_human_decisions")).toBe(false);
  });

  it("dates what was recorded after a plan ended without an entry as After close, exactly like the trade page, whole and paged", async () => {
    const [v1Draft, revision1, revision2, skippedPlan, skipPlanId, discarded, takenPlan, takenPlanId, takenProposal] = uuids(9);
    const [legacyBeforeSkip, legacyAfterSkip, beforeSkip, staleAfterSkip, postAfterSkip, afterDiscard, takenLater] = uuids(7);
    const image = { original_filename: "chart.png", mime_type: "image/png", byte_size: 2048, width: 1280, height: 720, sha256: "a".repeat(64) };
    const v2 = (id: string, tradeId: string, phase: string, recordedAt: string) => ({
      id, user_id: UID, trade_id: tradeId, storage_path: `${UID}/${tradeId}/${id}`, label: "OTHER", timeframe: "M15", caption: null, ...image,
      phase, state_at_creation: "LOCKED", capture_method: "PASTE", copied_from: null, recorded_at: recordedAt,
    });
    const shot = (id: string, proposalId: string, uploadedAt: string) => ({
      id, user_id: UID, proposal_id: proposalId, role: "M15", storage_path: `${UID}/${proposalId}/${id}`, ...image, uploaded_at: uploadedAt,
    });
    const decision = (proposalId: string, decided: string, recordedAt: string) => ({
      id: randomUUID(), user_id: UID, proposal_id: proposalId, decision: decided, event_type: "HUMAN_DECISION", reason: null, risk_decision: "APPROVED",
      ai_decision: "NOT_EVALUATED", recorded_at: recordedAt,
    });
    client = new FakePostgrest({
      // V2 evidence: a plan skipped at 10:00 (before, stale pre-entry row after, post-trade row after); a draft discarded at
      // 11:00; a plan taken in V1 and still waiting for its entry.
      trade_evidence: { rows: [
        v2(beforeSkip, skippedPlan, "PRE_ENTRY", "2026-10-14T09:30:00+00:00"),
        v2(staleAfterSkip, skippedPlan, "PRE_ENTRY", "2026-10-14T10:15:00+00:00"),
        v2(postAfterSkip, skippedPlan, "POST_TRADE", "2026-10-14T10:20:00+00:00"),
        // Stored pre-entry before the database stored such records post-trade.
        v2(afterDiscard, discarded, "PRE_ENTRY", "2026-10-14T11:30:00+00:00"),
      ] },
      // V1 screenshots of a draft whose latest V1 decision (on its other revision) is a skip at 08:00.
      setup_screenshots: { rows: [
        shot(legacyBeforeSkip, revision2, "2026-10-14T07:50:00+00:00"),
        shot(legacyAfterSkip, revision2, "2026-10-14T08:10:00+00:00"),
        shot(takenLater, takenProposal, "2026-10-14T12:30:00+00:00"),
      ] },
      trade_revisions: { rows: [
        { proposal_id: revision1, trade_id: v1Draft, revision: 1, user_id: UID }, { proposal_id: revision2, trade_id: v1Draft, revision: 2, user_id: UID },
        { proposal_id: takenProposal, trade_id: takenPlan, revision: 1, user_id: UID },
      ] },
      setup_human_decisions: { rows: [
        decision(revision2, "TAKEN", "2026-10-14T07:40:00+00:00"), decision(revision1, "SKIPPED", "2026-10-14T08:00:00+00:00"),
        decision(takenProposal, "SKIPPED", "2026-10-14T12:00:00+00:00"), decision(takenProposal, "TAKEN", "2026-10-14T12:10:00+00:00"),
      ] },
      trade_dispositions: { rows: [{ id: randomUUID(), user_id: UID, plan_id: skipPlanId, status: "SKIPPED", reason: "No retest.", recorded_at: "2026-10-14T10:00:00+00:00" }] },
      trade_ledger: { numeric: ["entry_price"], rows: [
        ledgerTiming({ id: v1Draft, created_at: "2026-10-14T07:00:00+00:00", lifecycle: "SKIPPED", legacy_decision: "SKIPPED" }),
        ledgerTiming({ id: skippedPlan, created_at: "2026-10-14T09:00:00+00:00", plan_id: skipPlanId, lifecycle: "SKIPPED", disposition: "SKIPPED" }),
        ledgerTiming({ id: discarded, created_at: "2026-10-14T10:30:00+00:00", lifecycle: "DISCARDED", discarded_at: "2026-10-14T11:00:00+00:00" }),
        ledgerTiming({ id: takenPlan, created_at: "2026-10-14T11:50:00+00:00", plan_id: takenPlanId, lifecycle: "LOCKED", legacy_decision: "TAKEN" }),
      ] },
    });
    mock.client = client;
    const expected = {
      [legacyBeforeSkip]: "BEFORE_ENTRY", [legacyAfterSkip]: "AFTER_CLOSE", [beforeSkip]: "BEFORE_ENTRY", [staleAfterSkip]: "AFTER_CLOSE",
      [postAfterSkip]: "AFTER_CLOSE", [afterDiscard]: "AFTER_CLOSE", [takenLater]: "BEFORE_ENTRY",
    };
    const whole = (await exportJson("part=evidence-manifest")).document.manifest ?? [];
    expect(Object.fromEntries(whole.map((item) => [item.id, item.timing]))).toEqual(expected);

    client.calls.length = 0;
    const paged: EvidenceManifestItem[] = [];
    for (const table of ["trade_evidence", "setup_screenshots"]) paged.push(...((await exportJson(`part=evidence-manifest&table=${table}`)).document.manifest ?? []));
    const sorted = (items: readonly EvidenceManifestItem[]) => [...items].sort((a, b) => compare(a.id, b.id));
    expect(sorted(paged)).toEqual(sorted(whole));
    // Pages read only the ends their rows need: the named disposition, and the V1 decisions of skipped trades' revisions.
    const lookups = client.calls.filter((call) => (call.table === "trade_dispositions" || call.table === "setup_human_decisions") && call.gt === null);
    expect(lookups.map((call) => [call.table, call.in?.[0], [...(call.in?.[1] ?? [])].sort()])).toEqual([
      ["trade_dispositions", "plan_id", [skipPlanId]],
      ["setup_human_decisions", "proposal_id", [revision1, revision2].sort()],
    ]);
  });

  it("pages the manifest with the evidence rows, from page-scoped lookups, so a large account gets every item within the response budget", async () => {
    const [trade, proposal] = uuids(2);
    const image = { original_filename: "chart.png", mime_type: "image/png", byte_size: 2048, width: 1280, height: 720, sha256: "a".repeat(64) };
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 14, 8, minute)).toISOString();
    // 25 KB captions make an item as large as its row: the rows alone (about 2.8 MB) fit one page, but with their
    // manifest items (about 4.6 MB) they only fit the response limit when the page budget counts both.
    const evidence = uuids(110).map((id, n) => ({
      id, user_id: UID, trade_id: trade, storage_path: `${UID}/${trade}/${id}`, label: "ENTRY", timeframe: "M5", caption: "c".repeat(25_000), ...image,
      phase: "PRE_ENTRY", state_at_creation: "LOCKED", capture_method: "PASTE", copied_from: null, recorded_at: at(n),
    }));
    const screenshots = uuids(120).map((id, n) => ({ id, user_id: UID, proposal_id: proposal, role: "H4", storage_path: `${UID}/${proposal}/${id}`, ...image, uploaded_at: at(n) }));
    client = new FakePostgrest({
      trade_evidence: { rows: evidence },
      trade_evidence_labels: { rows: evidence.filter((_, n) => n % 3 === 0)
        .map((row, n) => ({ id: n + 1, evidence_id: row.id, user_id: UID, label: "HTF", timeframe: "H4", caption: "Relabelled", recorded_at: at(200) })) },
      trade_evidence_removals: { rows: evidence.filter((_, n) => n % 5 === 0).map((row) => ({ evidence_id: row.id, user_id: UID, recorded_at: at(300) })) },
      setup_screenshots: { rows: screenshots },
      setup_screenshot_removals: { rows: screenshots.filter((_, n) => n % 4 === 0)
        .map((row) => ({ screenshot_id: row.id, user_id: UID, proposal_id: proposal, recorded_at: at(300) })) },
      trade_revisions: { rows: [{ proposal_id: proposal, trade_id: trade, revision: 1, user_id: UID }] },
      trade_ledger: { rows: [ledgerTiming({ id: trade, created_at: at(0), entered_at: at(500), entry_recorded_at: at(500), entry_price: "1.1", plan_id: randomUUID(), lifecycle: "LIVE" })] },
    });
    mock.client = client;
    const whole = (await exportJson("part=evidence-manifest")).document.manifest ?? [];
    expect(whole).toHaveLength(230);
    expect(whole.filter((item) => item.label === "HTF" && item.caption === "Relabelled")).toHaveLength(37);
    client.calls.length = 0;

    const paged: EvidenceManifestItem[] = [];
    const pages: Record<string, number> = {};
    for (const table of ["trade_evidence", "setup_screenshots"]) {
      let after: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const { document }: { document: ExportDocument } = await exportJson(`part=evidence-manifest&table=${table}${after ? `&after=${after}` : ""}`);
        expect(JSON.stringify(document).length).toBeLessThan(4 * 1024 * 1024);
        // Exactly the items of this page's rows, in row order.
        expect((document.manifest ?? []).map((item) => item.id)).toEqual(document.tables[table].map((row) => row.id));
        paged.push(...(document.manifest ?? []));
        pages[table] = (pages[table] ?? 0) + 1;
        after = document.next ?? null;
        if (!after) break;
      }
    }
    expect(pages).toEqual({ trade_evidence: 2, setup_screenshots: 1 });
    const sorted = (items: readonly EvidenceManifestItem[]) => [...items].sort((a, b) => compare(a.id, b.id));
    expect(sorted(paged)).toEqual(sorted(whole));
    // Labels, removals, revisions and ledger timing are read for a page's rows only, at most 100 values per request.
    const lookups = client.calls.filter((call) => call.table !== "trade_evidence" && call.table !== "setup_screenshots");
    expect(new Set(lookups.map((call) => call.table))).toEqual(new Set(["trade_evidence_labels", "trade_evidence_removals", "setup_screenshot_removals", "trade_revisions", "trade_ledger"]));
    expect(lookups.filter((call) => call.in === null || call.in[1].length > 100)).toEqual([]);
    // Pages of the other tables carry no manifest.
    expect(Object.keys((await exportJson("part=evidence-manifest&table=trade_evidence_labels")).document)).not.toContain("manifest");
  });
});

describe("csvCell", () => {
  it.each([
    ["plain", '"plain"'], ["-1.25", '"-1.25"'], ["-", `"'-"`], ["-1e5", `"'-1e5"`], ["=1+1", `"'=1+1"`], ["+1", `"'+1"`], ["@a", `"'@a"`],
    ["\tx", `"'\tx"`], ["\rx", `"'\rx"`], ["\nx", `"'\nx"`], ['say "hi"', '"say ""hi"""'], [null, '""'], [true, '"true"'], [0, '"0"'], [["a", "b"], '"a; b"'],
  ])("renders %j as %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});

describe("export coverage of the final schema", () => {
  it("exports every tenant table exactly once, with its real primary key and every NUMERIC column as text", async () => {
    const db = await createTestDatabase();
    try {
      await db.applyMigrations();
      await db.admin();
      const { rows } = await db.query<{ name: string; tenant: boolean; key: string[] | null; numeric: string[] }>(`
        select c.relname as name,
               exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) as tenant,
               (select array_agg(a.attname::text order by array_position(k.conkey, a.attnum)) from pg_constraint k
                  join pg_attribute a on a.attrelid = c.oid and a.attnum = any (k.conkey) where k.conrelid = c.oid and k.contype = 'p') as key,
               coalesce((select array_agg(a.attname::text order by a.attname) from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.atttypid = 'numeric'::regtype), '{}') as numeric
          from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1`);
      const catalog = new Map(rows.map((row) => [row.name, row]));
      const exported = Object.values(EXPORT_TABLES).flat();
      const names = exported.map((table) => table.name);
      expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
      expect(rows.filter((row) => row.tenant && !names.includes(row.name)).map((row) => row.name)).toEqual([]);
      for (const table of exported) {
        const actual = catalog.get(table.name);
        expect(actual, table.name).toBeDefined();
        expect(actual?.tenant, table.name).toBe(true);
        expect(actual?.key, table.name).toEqual([...table.key]);
        expect(actual?.numeric, table.name).toEqual([...table.numeric].sort());
      }
      const view = await db.query<{ name: string }>("select column_name as name from information_schema.columns where table_schema = 'public' and table_name = 'trade_ledger' order by ordinal_position");
      expect(view.rows.map((row) => row.name)).toEqual([...LEDGER_COLUMNS]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
