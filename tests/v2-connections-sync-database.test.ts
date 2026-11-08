import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: vi.fn() }));

import type { ExecutionSyncProvider } from "@/domain/sync/contract";
import { MOCK_POSITIONS } from "@/domain/sync/mock-provider";
import { type Db, loadConnection, type PlatformConnection, syncConnection } from "@/lib/sync-service";
import { type ApiRole, createTestDatabase, OWNER, type TestDatabase } from "./helpers/pglite";

// docs/V2_ARCHITECTURE.md §8.6 end to end: the real sync orchestration (src/lib/sync-service.ts syncConnection → domain
// runSync → ingest_external_execution / record_platform_sync_status of 0017) over PGlite with every migration. The
// trader's reads run as the owner under RLS, ingest and status as the trusted server (service_role), as in production.

type Row = Record<string, unknown>;
interface RestResult { data: unknown; error: { message: string } | null }

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return `"${name}"`;
}
/** `col` or `col::type`, serialized under the column's name as PostgREST does. */
function selectList(columns: string): string {
  return columns.split(",").map(item => {
    const match = /^([a-z_][a-z0-9_]*)(?:::([a-z]+))?$/.exec(item.trim());
    if (!match) throw new Error(`Unsupported select item ${item}`);
    return `${identifier(match[1])}${match[2] ? `::${match[2]}` : ""} as ${identifier(match[1])}`;
  }).join(", ");
}

/**
 * The PostgREST subset sync-service sends, run on PGlite as one API role and subject per call (the database is a single
 * session, and the sync interleaves the trader's reads with the trusted server's writes).
 */
function client(db: TestDatabase, role: ApiRole, subject: string): Db {
  const asActor = async <T>(run: () => Promise<T>): Promise<T> => {
    await db.actor(subject, role);
    return run();
  };
  const failure = (error: unknown): RestResult => ({ data: null, error: { message: error instanceof Error ? error.message : String(error) } });
  return {
    from(table: string) {
      let columns = "*";
      const where: string[] = [];
      const params: unknown[] = [];
      const orders: string[] = [];
      let cap: number | null = null;
      const compare = (column: string, operator: string, value: unknown) => {
        params.push(value);
        where.push(`${identifier(column)} ${operator} $${params.length}`);
        return chain;
      };
      const run = (): Promise<RestResult> => asActor(async () => {
        const sql = `select to_jsonb(q) as row from (select ${columns === "*" ? "*" : selectList(columns)} from public.${identifier(table)}`
          + (where.length ? ` where ${where.join(" and ")}` : "") + (orders.length ? ` order by ${orders.join(", ")}` : "")
          + (cap === null ? "" : ` limit ${cap}`) + ") q";
        try {
          return { data: (await db.query<{ row: Row }>(sql, params)).rows.map(item => item.row), error: null };
        } catch (error) {
          return failure(error);
        }
      });
      const chain = {
        select: (list: string) => { columns = list; return chain; },
        eq: (column: string, value: unknown) => compare(column, "=", value),
        gt: (column: string, value: unknown) => compare(column, ">", value),
        in: (column: string, values: readonly unknown[]) => {
          params.push(values.map(String));
          where.push(`${identifier(column)}::text = any($${params.length}::text[])`);
          return chain;
        },
        is: (column: string, value: null) => {
          if (value !== null) throw new Error("Unsupported is-filter");
          where.push(`${identifier(column)} is null`);
          return chain;
        },
        not: (column: string, operator: string, value: null) => {
          if (operator !== "is" || value !== null) throw new Error("Unsupported not-filter");
          where.push(`${identifier(column)} is not null`);
          return chain;
        },
        order: (column: string, options: { ascending?: boolean } = {}) => {
          orders.push(`${identifier(column)} ${options.ascending ?? true ? "asc" : "desc"}`);
          return chain;
        },
        limit: (count: number) => { cap = count; return chain; },
        // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
        then: (resolve: (value: RestResult) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
      };
      return chain;
    },
    rpc(fn: string, args: Row = {}): Promise<RestResult> {
      return asActor(async () => {
        const names = Object.keys(args);
        const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
        const list = names.map((name, index) => `${identifier(name)} => $${index + 1}${isObject(args[name]) ? "::jsonb" : ""}`).join(", ");
        const values = names.map(name => (isObject(args[name]) ? JSON.stringify(args[name]) : args[name]));
        try {
          const { rows } = await db.query<{ result: unknown }>(`select to_jsonb(public.${identifier(fn)}(${list})) as result`, values);
          return { data: rows[0]?.result ?? null, error: null };
        } catch (error) {
          return failure(error);
        }
      });
    },
  } as unknown as Db;
}

class FixedProvider implements ExecutionSyncProvider {
  readonly id = "MOCK" as const;
  readonly readOnly = true as const;
  constructor(private readonly positions: readonly unknown[]) {}
  async fetchPositions(): Promise<readonly unknown[]> {
    return structuredClone([...this.positions]);
  }
}

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
}, 60_000);
afterAll(async () => { await db.close(); });

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, params)).rows[0].value;
}

describe("syncing an archived trading account (§8.6, §3.2)", () => {
  it("defers only the new positions the archive refuses, keeps syncing the rest and imports them after a restore", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.actor(OWNER);
    const connectionId = await value<string>("select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [a.accountId, randomUUID()]);
    const trader = client(db, "authenticated", OWNER);
    const server = client(db, "service_role", "");
    const sync = async (positions: readonly unknown[]) => {
      const connection = await loadConnection(trader, connectionId);
      if (connection === null) throw new Error("connection");
      return { connection, result: await syncConnection({ db: trader, admin: server, userId: OWNER, connection, provider: new FixedProvider(positions), now: new Date().toISOString() }) };
    };
    const status = async (): Promise<PlatformConnection> => {
      const connection = await loadConnection(trader, connectionId);
      if (connection === null) throw new Error("connection");
      return connection;
    };
    const setStatus = async (next: "ACTIVE" | "ARCHIVED") => {
      await db.actor(OWNER);
      await db.query("select public.update_account_profile($1, $2::jsonb)", [a.accountId, JSON.stringify({ status: next })]);
    };
    const tradeOf = async (externalId: string) => {
      await db.actor(OWNER);
      // undefined: no execution was stored for that platform position.
      const { rows } = await db.query<{ value: { lifecycle: string; net_pnl: string | null } | null }>(
        `select (select to_jsonb(x) from (select l.lifecycle, l.net_pnl::text as net_pnl from public.trade_ledger l where l.id = s.linked_trade_id) x) as value
           from public.external_execution_status s where s.connection_id = $1 and s.external_id = $2`, [connectionId, externalId]);
      return rows[0]?.value;
    };

    // Sync 1, while active: an open position becomes an imported live trade.
    const fixture = MOCK_POSITIONS[0];
    const open = { ...fixture, externalId: "ARCH-OPEN", enteredAt: ago(120), exitPrice: null, exitedAt: null, commission: null, swap: null, realizedPnl: null };
    const first = await sync([open]);
    expect(first.result).toMatchObject({ ok: true, report: { status: "SYNCED", created: 1 } });
    const cursor = (await status()).syncedThrough;
    expect(cursor).not.toBeNull();
    expect(await tradeOf("ARCH-OPEN")).toEqual({ lifecycle: "LIVE", net_pnl: null });

    // Sync 2, archived: a new position entered earlier comes first in the batch and is refused; the close of the
    // imported position after it is still applied, and the cursor stays so the refused one is fetched again.
    await setStatus("ARCHIVED");
    const closed = { ...open, exitPrice: "1.10612", exitedAt: ago(10), commission: "-1.75", swap: "0", realizedPnl: "148.25" };
    const earlier = { ...fixture, externalId: "ARCH-NEW", enteredAt: ago(150), exitedAt: ago(140) };
    const second = await sync([closed, earlier]);
    expect(second.result).toMatchObject({
      ok: true,
      report: { status: "SYNCED", created: 0, closed: 1, deferred: [{ externalId: "ARCH-NEW" }], syncedThrough: cursor },
    });
    const archivedState = await status();
    expect(archivedState).toMatchObject({ status: "SYNCED", syncedThrough: cursor, executionCount: 1 });
    expect(archivedState.statusMessage).toBe(
      "Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation, 1 closed. 1 new position was not imported because this trading account is archived; restore it and sync again to import it.",
    );
    expect(await tradeOf("ARCH-OPEN")).toEqual({ lifecycle: "CLOSED", net_pnl: "148.25" });
    expect(await tradeOf("ARCH-NEW")).toBeUndefined();
    // Syncing again while archived changes nothing and still explains why.
    expect((await sync([closed, earlier])).result).toMatchObject({ ok: true, report: { status: "SYNCED", unchanged: 1, deferred: [{ externalId: "ARCH-NEW" }] } });

    // Restored: the next sync imports the deferred position and the cursor moves on.
    await setStatus("ACTIVE");
    const third = await sync([closed, earlier]);
    expect(third.result).toMatchObject({ ok: true, report: { status: "SYNCED", created: 1, unchanged: 1, deferred: [] } });
    expect(await tradeOf("ARCH-NEW")).toEqual({ lifecycle: "CLOSED", net_pnl: "148.25" });
    const restored = await status();
    expect(restored).toMatchObject({ status: "SYNCED", executionCount: 2, unmatchedCount: 0 });
    expect(Date.parse(String(restored.syncedThrough))).toBeGreaterThan(Date.parse(String(cursor)));
  });
});
