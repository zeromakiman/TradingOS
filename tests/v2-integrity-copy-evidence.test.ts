import { describe, expect, it, vi } from "vitest";

// Duplicating a draft copies only the source's evidence that was Before entry there (docs/V2_ARCHITECTURE.md §7.4):
// the server's selection (`copyableEvidence`) follows the same rule as `private.copyable_evidence`, so nothing
// recorded after a plan ended without an entry (skip, cancellation, discard, V1 skip) is offered for copying, whatever
// phase an older row stored. The database re-checks every copy (tests/v2-integrity-plan-end.test.ts).

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => null, requireUser: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));

import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { copyableEvidence } from "@/lib/evidence";

type Row = Record<string, unknown>;

/** The PostgREST calls `copyableEvidence` makes: equality and `in` filters, ordering, a limit, one or many rows. */
class Query {
  private readonly predicates: ((row: Row) => boolean)[] = [];
  private readonly orders: [string, boolean][] = [];
  private cap: number | null = null;
  private one = false;
  constructor(private readonly rows: Row[]) {}
  select(): this { return this; }
  eq(column: string, value: unknown): this { this.predicates.push(row => row[column] === value); return this; }
  in(column: string, values: readonly unknown[]): this { this.predicates.push(row => values.includes(row[column])); return this; }
  order(column: string, options: { ascending?: boolean } = {}): this { this.orders.push([column, options.ascending ?? true]); return this; }
  limit(count: number): this { this.cap = count; return this; }
  maybeSingle(): this { this.one = true; return this; }
  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A>(resolve: (value: { data: unknown; error: null }) => A): Promise<A> {
    let rows = this.rows.filter(row => this.predicates.every(predicate => predicate(row)));
    rows = [...rows].sort((a, b) => {
      for (const [column, ascending] of this.orders) {
        const order = String(a[column]).localeCompare(String(b[column]));
        if (order !== 0) return ascending ? order : -order;
      }
      return 0;
    });
    if (this.cap !== null) rows = rows.slice(0, this.cap);
    return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null }).then(resolve);
  }
}

class Db {
  readonly read: string[] = [];
  constructor(private readonly tables: Record<string, Row[]>) {}
  from(table: string): Query {
    this.read.push(table);
    return new Query(this.tables[table] ?? []);
  }
}

const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const SOURCE = "a0000000-0000-4000-8000-000000000001";
const PLAN = "b0000000-0000-4000-8000-000000000001";
const PROPOSAL = "c0000000-0000-4000-8000-000000000001";
const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "ab".repeat(32);

function ledger(changes: Partial<LedgerTrade>): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: SOURCE, account_id: ACCOUNT, origin: "PLANNED", created_at: "2026-10-23T12:00:00.000000Z", currency: "USD", revision_count: 1, latest_revision: 1,
    latest_proposal_id: PROPOSAL, entry_time_known: false, lifecycle: "DRAFT", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes,
  };
}

function evidence(n: number, phase: "PRE_ENTRY" | "POST_TRADE", recordedAt: string): Row {
  return {
    id: id(n), trade_id: SOURCE, user_id: USER, storage_path: `${USER}/${SOURCE}/${id(n)}`, label: "ENTRY", timeframe: "M5", caption: null, original_filename: "chart.png",
    mime_type: "image/png", byte_size: 100, sha256: SHA, width: 800, height: 600, phase, recorded_at: recordedAt,
  };
}

function screenshot(n: number, uploadedAt: string): Row {
  return {
    id: id(n), proposal_id: PROPOSAL, user_id: USER, role: "M15", storage_path: `${USER}/${PROPOSAL}/${id(n)}`, original_filename: "m15.png", mime_type: "image/png",
    byte_size: 100, sha256: SHA, width: 640, height: 480, uploaded_at: uploadedAt,
  };
}

/** A source with screenshots before 13:00 and after it (one of them stored pre-entry before the database knew the end). */
function tables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    trade_revisions: [{ proposal_id: PROPOSAL, trade_id: SOURCE, user_id: USER }],
    trade_evidence: [
      evidence(1, "PRE_ENTRY", "2026-10-23T12:30:00.000000Z"),
      evidence(2, "POST_TRADE", "2026-10-23T13:10:00.000000Z"),
      evidence(3, "PRE_ENTRY", "2026-10-23T13:20:00.000000Z"),
    ],
    setup_screenshots: [screenshot(4, "2026-10-23T12:40:00.000000Z"), screenshot(5, "2026-10-23T13:30:00.000000Z")],
    ...extra,
  };
}

const ENDED_AT = "2026-10-23T13:00:00.000000Z";
const copiedIds = async (db: Db, source: LedgerTrade) => (await copyableEvidence(db as never, USER, source)).map(candidate => candidate.sourceId);

describe("which screenshots a duplicate copies (§7.4)", () => {
  it("copies every active screenshot of an open draft, and reads no end facts for it", async () => {
    const db = new Db(tables());
    // A row stored post-trade is never copied, whatever the source's state.
    expect(await copiedIds(db, ledger({}))).toEqual([id(1), id(4), id(3), id(5)]);
    expect(db.read).not.toContain("trade_dispositions");
    expect(db.read).not.toContain("setup_human_decisions");
  });

  it.each([
    ["skipped", { lifecycle: "SKIPPED" as const, disposition: "SKIPPED" as const, plan_id: PLAN, locked_at: "2026-10-23T12:10:00.000000Z", draft_check: null }],
    ["cancelled", { lifecycle: "CANCELLED" as const, disposition: "CANCELLED" as const, plan_id: PLAN, locked_at: "2026-10-23T12:10:00.000000Z", draft_check: null }],
  ])("copies only what was recorded before a plan was %s", async (_name, changes) => {
    const db = new Db(tables({ trade_dispositions: [{ plan_id: PLAN, user_id: USER, recorded_at: ENDED_AT }] }));
    expect(await copiedIds(db, ledger(changes))).toEqual([id(1), id(4)]);
    expect(db.read).toContain("trade_dispositions");
  });

  it("copies only what was recorded before a draft was discarded", async () => {
    const db = new Db(tables());
    expect(await copiedIds(db, ledger({ lifecycle: "DISCARDED", discarded_at: ENDED_AT, draft_check: null }))).toEqual([id(1), id(4)]);
  });

  it("dates a V1 skip by the latest V1 decision of the trade's revisions", async () => {
    const db = new Db(tables({
      setup_human_decisions: [
        { id: id(10), proposal_id: PROPOSAL, user_id: USER, decision: "TAKEN", recorded_at: "2026-10-23T12:20:00.000000Z" },
        { id: id(11), proposal_id: PROPOSAL, user_id: USER, decision: "SKIPPED", recorded_at: ENDED_AT },
      ],
    }));
    expect(await copiedIds(db, ledger({ lifecycle: "SKIPPED", legacy_decision: "SKIPPED", draft_check: null }))).toEqual([id(1), id(4)]);
  });
});
