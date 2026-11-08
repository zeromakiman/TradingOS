import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, OWNER, type BootstrappedAccount, type TestDatabase } from "./helpers/pglite";

// The server actions and the account workspace against the real database (every migration, in-memory PGlite) through
// a small PostgREST adapter that runs as the signed-in owner (role authenticated, RLS on):
// - "now" (or an empty entry/exit time) is resolved on the server, so a resubmitted form used to carry a new instant and
//   was refused although the first submission had been recorded; Record Live Trade then invited a reload that recorded a
//   second position. A resubmission now replays the recorded record; other reported values are still refused.
// - The Plan Trade preview built from the account workspace blocks a proposal that repeats a plan locked today exactly
//   as the server check does (DUPLICATE, spec §6.3), instead of showing it as ready.

const m = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// Every unexpected error surfaces in the test instead of turning into the generic failure copy.
vi.mock("next/navigation", () => ({ unstable_rethrow: (error: unknown) => { throw error; } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => m.session }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: () => undefined }));

import { idleState } from "@/app/actions/state";
import { closeLiveTrade, closePlannedTrade, createPlannedTrade, lockPlan, recordEntry, recordLiveTrade } from "@/app/actions/trades";
import { dailyUsageSchema, evaluateRisk } from "@/domain/risk";
import { type RiskReportV12, riskReportSchemaV12 } from "@/domain/risk-report";
import { strategyClock } from "@/domain/session";
import { loadAccount } from "@/lib/account-context";
import { loadAccountWorkspace, riskContextFor } from "@/lib/workspace";

// ---------------------------------------------------------------------------------------------------------------------
// PostgREST over PGlite: `from(table)` with the filters the code under test uses, `rpc(fn, args)` with named
// arguments. Rows and function results are serialized by PostgreSQL's JSON functions, as PostgREST serializes them
// (timestamps as ISO 8601 with an offset, NUMERIC as JSON numbers unless cast to text).
// ---------------------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
interface RestResult { data: unknown; error: { message: string; code: string } | null }

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return `"${name}"`;
}

/** `col`, `col::type`, `alias:col`, `alias:col::type` or `*`. */
function selectList(columns: string): string {
  return columns.split(",").map(item => {
    const text = item.trim();
    if (text === "*") return "*";
    const match = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(?:::([a-z]+))?$/.exec(text);
    if (!match) throw new Error(`Unsupported select item ${text}`);
    const [, alias, column, cast] = match;
    return `${identifier(column)}${cast ? `::${cast}` : ""} as ${identifier(alias ?? column)}`;
  }).join(", ");
}

function failure(error: unknown): RestResult {
  return { data: null, error: { message: error instanceof Error ? error.message : String(error), code: String((error as { code?: unknown }).code ?? "") } };
}

class PgQuery implements PromiseLike<RestResult> {
  private columns = "*";
  private readonly where: string[] = [];
  private readonly params: unknown[] = [];
  private readonly orders: string[] = [];
  private cap: number | null = null;
  private mode: "many" | "maybe" = "many";

  constructor(private readonly db: TestDatabase, private readonly table: string) {}

  select(columns = "*"): this { this.columns = columns; return this; }
  private compare(column: string, operator: string, value: unknown): this {
    this.params.push(value);
    this.where.push(`${identifier(column)} ${operator} $${this.params.length}`);
    return this;
  }
  eq(column: string, value: unknown): this { return this.compare(column, "=", value); }
  lt(column: string, value: unknown): this { return this.compare(column, "<", value); }
  lte(column: string, value: unknown): this { return this.compare(column, "<=", value); }
  gt(column: string, value: unknown): this { return this.compare(column, ">", value); }
  gte(column: string, value: unknown): this { return this.compare(column, ">=", value); }
  in(column: string, values: readonly unknown[]): this {
    this.params.push(values.map(String));
    this.where.push(`${identifier(column)}::text = any($${this.params.length}::text[])`);
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push(`${identifier(column)} ${options.ascending ?? true ? "asc" : "desc"}`);
    return this;
  }
  limit(count: number): this { this.cap = count; return this; }
  maybeSingle(): this { this.mode = "maybe"; return this; }

  private async run(): Promise<RestResult> {
    const sql = `select to_jsonb(q) as row from (select ${selectList(this.columns)} from public.${identifier(this.table)}`
      + (this.where.length ? ` where ${this.where.join(" and ")}` : "")
      + (this.orders.length ? ` order by ${this.orders.join(", ")}` : "")
      + (this.cap === null ? "" : ` limit ${this.cap}`) + ") q";
    try {
      const rows = (await this.db.query<{ row: Row }>(sql, this.params)).rows.map(item => item.row);
      if (this.mode === "many") return { data: rows, error: null };
      if (rows.length > 1) return { data: null, error: { message: "JSON object requested, multiple rows returned", code: "PGRST116" } };
      return { data: rows[0] ?? null, error: null };
    } catch (error) {
      return failure(error);
    }
  }

  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A = RestResult, B = never>(onfulfilled?: ((value: RestResult) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }
}

class PgRest {
  readonly rpcCalls: { fn: string; args: Row }[] = [];
  constructor(readonly db: TestDatabase) {}
  from(table: string): PgQuery { return new PgQuery(this.db, table); }
  async rpc(fn: string, args: Row = {}): Promise<RestResult> {
    this.rpcCalls.push({ fn, args });
    const names = Object.keys(args);
    const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
    const list = names.map((name, index) => `${identifier(name)} => $${index + 1}${isObject(args[name]) ? "::jsonb" : ""}`).join(", ");
    const values = names.map(name => (isObject(args[name]) ? JSON.stringify(args[name]) : args[name]));
    try {
      const { rows } = await this.db.query<{ result: unknown }>(`select to_jsonb(public.${identifier(fn)}(${list})) as result`, values);
      return { data: rows[0]?.result ?? null, error: null };
    } catch (error) {
      return failure(error);
    }
  }
  calls(fn: string): Row[] { return this.rpcCalls.filter(call => call.fn === fn).map(call => call.args); }
}

// ---------------------------------------------------------------------------------------------------------------------
let db: TestDatabase;
let rest: PgRest;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // Locks need an eligible session; the workspace preview below evaluates at 14:00Z (kill zone) of the usage day.
  await db.pinSession("ACTIVE_KILL_ZONE");
  rest = new PgRest(db);
  m.session = { db: rest, user: { id: OWNER, email: "owner@example.test" } };
}, 120_000);
afterAll(async () => { await db.close(); });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Lets the clock move on, so a second "now" is a different instant than the first. */
const laterInstant = () => new Promise(resolve => setTimeout(resolve, 5));

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) rows`, params)).rows[0].n);
}

const proposalFor = (a: BootstrappedAccount) => ({
  instrumentId: a.instrumentId, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5",
  narrative: "Sweep of the Asia low into the H4 order block.", contractConfirmed: true, news: "CLEAR", contradiction: false,
});

async function plannedTrade(a: BootstrappedAccount): Promise<string> {
  const created = await createPlannedTrade(idleState, form({
    accountId: a.accountId, requestKey: randomUUID(), riskPlanId: a.riskId, observationId: a.observationId, proposal: JSON.stringify(proposalFor(a)),
  }));
  expect(created).toMatchObject({ status: "success", data: { decision: "APPROVED", revision: 1 } });
  if (created.status !== "success" || !created.data) throw new Error("draft expected");
  return created.data.tradeId;
}

const ALREADY_CLOSED = { status: "error", message: "This trade is already closed with different values." };

// ---------------------------------------------------------------------------------------------------------------------
describe("server-resolved times replay a resubmitted form exactly", () => {
  it("Record Live Trade with entry time now: a retry or a double click returns the recorded trade, never a second position", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const key = randomUUID();
    const fields = { accountId: a.accountId, requestKey: key, instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.10000", quantity: "0.10", enteredAt: "now" };
    const first = await recordLiveTrade(idleState, form(fields));
    expect(first).toMatchObject({ status: "success", data: { tradeId: expect.any(String) } });
    await laterInstant();
    const retried = await recordLiveTrade(idleState, form(fields));
    expect(retried).toEqual(first);
    // The retry reached the database with a new instant first, then replayed with the recorded one.
    const calls = rest.calls("record_live_trade").filter(call => call.p_request_key === key);
    expect(calls).toHaveLength(3);
    expect((calls[1].p_input as Row).enteredAt).not.toBe((calls[0].p_input as Row).enteredAt);
    expect(new Date(String((calls[2].p_input as Row).enteredAt)).getTime()).toBe(new Date(String((calls[0].p_input as Row).enteredAt)).getTime());
    await laterInstant();
    const doubleClick = await Promise.all([recordLiveTrade(idleState, form(fields)), recordLiveTrade(idleState, form(fields))]);
    expect(doubleClick).toEqual([first, first]);
    expect(await count("select 1 from public.trades where request_key = $1", [key])).toBe(1);
    expect(await count("select 1 from public.trades where account_id = $1", [a.accountId])).toBe(1);
    // One live trade uses one of today's slots.
    expect(dailyUsageSchema.parse((await rest.rpc("get_daily_risk_usage", { p_account_id: a.accountId })).data).unplannedTrades).toBe(1);
  });

  it("Record Live Trade: other details under the same form key stay refused, with copy that does not invite a second recording", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const key = randomUUID();
    const fields = { accountId: a.accountId, requestKey: key, instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.10000", enteredAt: "now" };
    expect(await recordLiveTrade(idleState, form(fields))).toMatchObject({ status: "success" });
    const conflict = { status: "error", message: "This form already recorded a live trade with other details. Open it from Today instead of recording it again." };
    await laterInstant();
    expect(await recordLiveTrade(idleState, form({ ...fields, entryPrice: "1.10010" }))).toEqual(conflict);
    expect(await recordLiveTrade(idleState, form({ ...fields, direction: "SHORT" }))).toEqual(conflict);
    // A reported entry time is a value, not a default: it must match the recorded one.
    expect(await recordLiveTrade(idleState, form({ ...fields, enteredAt: "2026-01-02T03:04:05Z" }))).toEqual(conflict);
    // "Already open, time unknown" first, "now" later: different values.
    const unknownKey = randomUUID();
    const unknown = { ...fields, requestKey: unknownKey, enteredAt: "" };
    expect(await recordLiveTrade(idleState, form(unknown))).toMatchObject({ status: "success" });
    expect(await recordLiveTrade(idleState, form({ ...unknown, enteredAt: "now" }))).toEqual(conflict);
    expect(await count("select 1 from public.trades where account_id = $1", [a.accountId])).toBe(2);
  });

  it("Record entry and Close trade (planned) with a default time replay the recorded fill and outcome", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const tradeId = await plannedTrade(a);
    expect(await lockPlan(idleState, form({ tradeId, expectedRevision: "1" }))).toMatchObject({ status: "success", data: { locked: true } });
    await laterInstant();
    const entry = { tradeId, entry: "1.10000", quantity: "0.25", enteredAt: "" };
    const entered = await recordEntry(idleState, form(entry));
    expect(entered).toEqual({ status: "success", message: "Entry recorded. The trade is live.", data: { oversize: false, plannedQuantity: "0.25", actualQuantity: "0.25" } });
    await laterInstant();
    expect(await recordEntry(idleState, form(entry))).toEqual(entered);
    expect(await recordEntry(idleState, form({ ...entry, enteredAt: "now" }))).toEqual(entered);
    const refused = { status: "error", message: "The entry is already recorded. Recorded fills can't be changed." };
    expect(await recordEntry(idleState, form({ ...entry, entry: "1.10010" }))).toEqual(refused);
    expect(await recordEntry(idleState, form({ ...entry, quantity: "0.2" }))).toEqual(refused);
    expect(await recordEntry(idleState, form({ ...entry, enteredAt: "2026-01-02T03:04:05Z" }))).toEqual(refused);
    expect(await count("select 1 from public.trade_executions e join public.trade_plan_links l on l.plan_id = e.plan_id where l.trade_id = $1", [tradeId])).toBe(1);

    await laterInstant();
    const close = { tradeId, exit: "1.10100", exitedAt: "now" };
    const closed = await closePlannedTrade(idleState, form(close));
    expect(closed).toEqual({ status: "success", message: "Trade closed. Write your review while it is fresh.", data: { outcome: "WIN", netPnl: "25", realizedR: "0.5" } });
    await laterInstant();
    expect(await closePlannedTrade(idleState, form(close))).toEqual(closed);
    expect(await closePlannedTrade(idleState, form({ ...close, exitedAt: "" }))).toEqual(closed);
    expect(await closePlannedTrade(idleState, form({ ...close, exit: "1.10200" }))).toEqual(ALREADY_CLOSED);
    expect(await closePlannedTrade(idleState, form({ ...close, fees: "1.50" }))).toEqual(ALREADY_CLOSED);
    expect(await count("select 1 from public.trade_outcomes o join public.trade_plan_links l on l.plan_id = o.plan_id where l.trade_id = $1", [tradeId])).toBe(1);
  });

  it("Close trade (live-first) with a default time replays the recorded close; other fees or P&L stay refused", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const recorded = await recordLiveTrade(idleState, form({
      accountId: a.accountId, requestKey: randomUUID(), instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.10000", quantity: "0.10", enteredAt: "now",
    }));
    if (recorded.status !== "success" || !recorded.data) throw new Error("live trade expected");
    const tradeId = recorded.data.tradeId;
    await laterInstant();
    const close = { tradeId, exitPrice: "1.10100", exitedAt: "" };
    const closed = await closeLiveTrade(idleState, form(close));
    expect(closed).toEqual({ status: "success", message: "Trade closed. Write your review while it is fresh.", data: { outcome: "WIN", netPnl: "10", realizedR: null } });
    await laterInstant();
    expect(await closeLiveTrade(idleState, form(close))).toEqual(closed);
    expect(await closeLiveTrade(idleState, form({ ...close, exitedAt: "now" }))).toEqual(closed);
    expect(await closeLiveTrade(idleState, form({ ...close, fees: "2" }))).toEqual(ALREADY_CLOSED);
    expect(await closeLiveTrade(idleState, form({ ...close, exitPrice: "1.10200" }))).toEqual(ALREADY_CLOSED);
    expect(await count("select 1 from public.trade_unplanned_closes where trade_id = $1", [tradeId])).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the account workspace preview agrees with the server check on DUPLICATE", () => {
  /** The preview equals the stored check except evaluatedAt, which lies on the same strategy day. */
  function expectSameReport(preview: RiskReportV12, stored: RiskReportV12): void {
    const { evaluatedAt: previewAt, ...shown } = preview;
    const { evaluatedAt: storedAt, ...server } = stored;
    expect(server).toEqual(shown);
    expect(strategyClock(storedAt).day).toBe(strategyClock(previewAt).day);
    expect(riskReportSchemaV12.safeParse(stored).success).toBe(true);
  }

  it("a proposal identical to a plan locked today is blocked by the preview exactly like the stored check", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const original = await plannedTrade(a);
    expect(await lockPlan(idleState, form({ tradeId: original, expectedRevision: "1" }))).toMatchObject({ status: "success" });
    const raw = proposalFor(a);
    const again = await createPlannedTrade(idleState, form({
      accountId: a.accountId, requestKey: randomUUID(), riskPlanId: a.riskId, observationId: a.observationId, proposal: JSON.stringify(raw),
    }));
    expect(again).toMatchObject({
      status: "success", data: { decision: "BLOCKED" },
      message: "Draft saved. Risk check: Blocked — An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today.",
    });
    if (again.status !== "success" || !again.data) throw new Error("draft expected");
    const stored = (await db.query<{ result: RiskReportV12 }>(
      "select e.result from public.trade_ledger l join public.risk_evaluations e on e.id = l.latest_check_evaluation_id where l.id = $1", [again.data.tradeId])).rows[0].result;
    expect(stored.issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code)).toEqual(["DUPLICATE"]);

    // What Plan Trade / Edit Draft evaluate in the browser: the account workspace at server time (14:00Z = kill zone).
    const usageDay = dailyUsageSchema.parse((await rest.rpc("get_daily_risk_usage", { p_account_id: a.accountId })).data).day;
    const account = await loadAccount(rest as never, OWNER, a.accountId);
    if (!account) throw new Error("account expected");
    const workspace = await loadAccountWorkspace(rest as never, OWNER, account, `${usageDay}T14:00:00.000Z`);
    expect(workspace.todaysPlans).toEqual([{ instrumentVersionId: a.instrumentId, proposal: raw }]);
    const context = riskContextFor(workspace, a.instrumentId, raw);
    if (!context) throw new Error("context expected");
    expect(context.duplicate).toBe(true);
    expectSameReport(evaluateRisk(raw, context), stored);
    // A changed price is no duplicate; a context without the proposal (currency checks only) never claims one.
    expect(riskContextFor(workspace, a.instrumentId, { ...raw, entry: "1.10001" })?.duplicate).toBe(false);
    expect(riskContextFor(workspace, a.instrumentId)?.duplicate).toBe(false);
  });
});
