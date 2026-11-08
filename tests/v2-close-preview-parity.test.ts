import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ClosePosition, type ClosePreview, calculatedClose, reportedClose } from "@/domain/close-preview";
import { previewProposal } from "@/domain/fixtures";
import { formatR, formatSignedMoney } from "@/domain/format";
import { averageExit, closeLegs, journalDecimal, journalPercent, type SplitClose } from "@/domain/partial-closes";
import { type BootstrappedAccount, createTestDatabase, OWNER, type TestDatabase } from "./helpers/pglite";

// The close confirmation shows the result before the close is recorded (spec §57). These closes are recorded through
// the real RPCs on a fully migrated database: what close_planned_trade (FULL_CLOSE_V1) and close_live_trade
// (UNPLANNED_CLOSE_V1) store must be exactly what the preview said, and an average exit worked out from the journal's
// partial closes must be a price the close accepts as it is (§3.6).

type Json = Record<string, unknown>;
interface Stored { direction: "LONG" | "SHORT"; entry_price: string | null; quantity: string | null; initial_risk: string | null; exit_price: string | null; gross_pnl: string | null; net_pnl: string; realized_r: string | null; outcome: string; tick_size: string | null; tick_value: string | null }

/** Wed Oct 21 2026, 08:00 UTC−5 (the session is pinned as well). */
const NOW = "2026-10-21T13:00:00.000Z";
let db: TestDatabase;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  db = await createTestDatabase();
  await db.applyMigrations();
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 120_000);
afterAll(async () => {
  await db.close();
  vi.useRealTimers();
});

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  await db.actor(OWNER);
  return (await db.query<{ value: T }>(sql, params)).rows[0].value;
}

/** A locked plan on a fresh account (clear of daily limits), entered at `entry` with `quantity`. */
async function plannedLive(changes: Json, entry: string, quantity: string): Promise<string> {
  const a: BootstrappedAccount = await db.bootstrapAccount(OWNER);
  const proposal = { ...previewProposal, instrumentId: a.instrumentId, narrative: "Close preview parity", contractConfirmed: true, news: "CLEAR", ...changes };
  const draft = await value<{ tradeId: string }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [a.accountId, JSON.stringify(proposal), randomUUID(), a.riskId, a.observationId]);
  const locked = await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [draft.tradeId]);
  expect(locked.planId).toBeTruthy();
  await value("select public.record_planned_entry($1, $2, $3, clock_timestamp()) as value", [draft.tradeId, entry, quantity]);
  return draft.tradeId;
}

async function liveFirst(input: Json): Promise<string> {
  const a = await db.bootstrapAccount(OWNER);
  return value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [a.accountId, JSON.stringify({ instrumentId: a.instrumentId, ...input }), randomUUID()]);
}

async function stored(tradeId: string): Promise<Stored> {
  await db.actor(OWNER);
  const { rows } = await db.query<Stored>(
    `select l.direction, l.entry_price, l.quantity, l.initial_risk, l.exit_price, l.gross_pnl, l.net_pnl, l.realized_r, l.outcome,
            trim_scale(i.tick_size)::text as tick_size, trim_scale(i.tick_value)::text as tick_value
       from public.trade_ledger l left join public.instrument_versions i on i.id = l.instrument_version_id where l.id = $1`, [tradeId]);
  return rows[0];
}

/** What the trade page knows before the close: the ledger's entry facts, contract and R basis. */
async function positionOf(tradeId: string): Promise<{ position: ClosePosition | null; riskBasis: string | null }> {
  const row = await stored(tradeId);
  const position = row.entry_price && row.quantity && row.tick_size && row.tick_value
    ? { direction: row.direction, entryPrice: row.entry_price, quantity: row.quantity, tickSize: row.tick_size, tickValue: row.tick_value }
    : null;
  return { position, riskBasis: row.initial_risk };
}

/** The stored close agrees with the preview: money exactly, R to the database's own precision and in its display. */
function expectSame(preview: ClosePreview | null, row: Stored): void {
  expect(preview).not.toBeNull();
  if (!preview) return;
  expect(row.outcome).toBe(preview.outcome);
  expect(new Decimal(row.net_pnl).eq(preview.netPnl)).toBe(true);
  expect(row.gross_pnl === null ? null : new Decimal(row.gross_pnl).toFixed()).toBe(preview.grossPnl === null ? null : new Decimal(preview.grossPnl).toFixed());
  expect(formatSignedMoney(row.net_pnl, "USD")).toBe(formatSignedMoney(preview.netPnl, "USD"));
  if (preview.realizedR === null || row.realized_r === null) {
    expect(row.realized_r).toBe(preview.realizedR);
    return;
  }
  expect(new Decimal(row.realized_r).minus(preview.realizedR).abs().lt("1e-12")).toBe(true);
  expect(formatR(row.realized_r)).toBe(formatR(preview.realizedR));
}

describe("the close confirmation shows what the database records (FULL_CLOSE_V1)", () => {
  const cases: { name: string; changes: Json; entry: string; quantity: string; exit: string; fees: string }[] = [
    { name: "a long win at the planned fill", changes: {}, entry: "1.10000", quantity: "0.25", exit: "1.10400", fees: "0" },
    { name: "a long loss with slippage, fees and a larger size", changes: {}, entry: "1.10002", quantity: "0.30", exit: "1.09931", fees: "3.17" },
    { name: "a short loss", changes: { direction: "SHORT", entry: "1.10000", stop: "1.10200", target: "1.09400" }, entry: "1.10000", quantity: "0.25", exit: "1.10013", fees: "1.11" },
    { name: "a breakeven after fees", changes: {}, entry: "1.10000", quantity: "0.25", exit: "1.10004", fees: "1" },
    // A 300-tick stop sizes 0.16 lots for $48.00 locked risk: R is a repeating decimal the database rounds.
    { name: "an R that doesn't terminate", changes: { stop: "1.09700", target: "1.10900" }, entry: "1.10000", quantity: "0.16", exit: "1.10625", fees: "0.35" },
  ];

  for (const scenario of cases) {
    it(scenario.name, async () => {
      const tradeId = await plannedLive(scenario.changes, scenario.entry, scenario.quantity);
      const { position, riskBasis } = await positionOf(tradeId);
      expect(position).not.toBeNull();
      const preview = calculatedClose(position as ClosePosition, scenario.exit, scenario.fees, riskBasis);
      await value("select public.close_planned_trade($1, $2, clock_timestamp(), $3) as value", [tradeId, scenario.exit, scenario.fees]);
      expectSame(preview, await stored(tradeId));
    });
  }
});

describe("the close confirmation shows what the database records (UNPLANNED_CLOSE_V1)", () => {
  it("calculates a live-first close from the contract, entry and size, with R on the stop's risk", async () => {
    const tradeId = await liveFirst({ direction: "LONG", entryPrice: "1.1", quantity: "0.4", initialStop: "1.098" });
    const { position, riskBasis } = await positionOf(tradeId);
    expect(riskBasis).toBe("80");
    const preview = calculatedClose(position as ClosePosition, "1.10333", "2.5", riskBasis);
    await value("select public.close_live_trade($1, $2::jsonb) as value", [tradeId, JSON.stringify({ exitPrice: "1.10333", exitedAt: new Date().toISOString(), fees: "2.5" })]);
    expectSame(preview, await stored(tradeId));
  });

  it("uses a reported risk amount as the R basis", async () => {
    const tradeId = await liveFirst({ direction: "SHORT", entryPrice: "1.1", quantity: "0.3", riskAmount: "70" });
    const { position, riskBasis } = await positionOf(tradeId);
    const preview = calculatedClose(position as ClosePosition, "1.10091", "0", riskBasis);
    await value("select public.close_live_trade($1, $2::jsonb) as value", [tradeId, JSON.stringify({ exitPrice: "1.10091", exitedAt: new Date().toISOString() })]);
    expectSame(preview, await stored(tradeId));
  });

  it("takes the trader's net P&L when it can't be calculated, with or without a risk basis", async () => {
    for (const [input, netPnl] of [[{ riskAmount: "40" }, "-55.25"], [{}, "42.5"]] as const) {
      const a = await db.bootstrapAccount(OWNER);
      const tradeId = await value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value",
        [a.accountId, JSON.stringify({ symbol: "XAUUSD", direction: "LONG", ...input }), randomUUID()]);
      const { riskBasis } = await positionOf(tradeId);
      const preview = reportedClose(netPnl, riskBasis);
      await value("select public.close_live_trade($1, $2::jsonb) as value", [tradeId, JSON.stringify({ exitedAt: new Date().toISOString(), netPnl })]);
      expectSame(preview, await stored(tradeId));
    }
  });
});

describe("an average exit worked out from the journal's partial closes", () => {
  it("is a price the close records as it is, and the result is the preview's", async () => {
    const tradeId = await plannedLive({}, "1.10000", "0.25");
    await value("select public.add_journal_entry($1, 'PARTIAL_CLOSE', 'Took 40% at the first target', $2::jsonb, $3) as value",
      [tradeId, JSON.stringify({ percent: "40", price: "1.10210" }), randomUUID()]);
    await db.actor(OWNER);
    const { rows } = await db.query<{ id: string; recorded_at: string; details: Json; phase: string }>(
      "select id, recorded_at::text, details, phase from public.trade_journal_entries where trade_id = $1 and kind = 'PARTIAL_CLOSE'", [tradeId]);
    expect(rows.map(row => row.phase)).toEqual(["LIVE"]);
    const records = rows.map(row => ({ id: row.id, recordedAt: row.recorded_at, price: journalDecimal(row.details.price), quantity: journalDecimal(row.details.quantity), percent: journalPercent(row.details.percent) }));
    const { position, riskBasis } = await positionOf(tradeId);
    const split = closeLegs(records, { quantity: position?.quantity ?? null }) as SplitClose;
    expect(split).toMatchObject({ kind: "SPLIT", remaining: "0.15", remainingPercent: "60" });
    // 40% at 1.10210 and 60% at 1.10377: 1.103102, recorded on the tick as 1.10310.
    const average = averageExit(split, "1.10377", "0.00001");
    expect(average).toEqual({ exact: "1.103102", price: "1.1031" });
    const preview = calculatedClose(position as ClosePosition, average?.price ?? "", "0", riskBasis);
    await value("select public.close_planned_trade($1, $2, clock_timestamp(), '0') as value", [tradeId, average?.price]);
    const row = await stored(tradeId);
    expect(row.exit_price).toBe("1.1031");
    expectSame(preview, row);
  });
});
