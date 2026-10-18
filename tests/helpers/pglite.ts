/**
 * Shared in-memory PostgreSQL harness for database tests (PGlite = PostgreSQL 18, plpgsql only).
 *
 *   const db = await createTestDatabase();          // Supabase-like stub + users OWNER and OTHER
 *   await db.applyMigrations();                     // every supabase/migrations/*.sql, lexical order
 *   await db.applyMigrations({ upTo: "0014" });     // only files whose numeric prefix is <= 0014;
 *                                                   // a later applyMigrations() applies the rest once
 *   await db.pinSession("ACTIVE_KILL_ZONE");        // private.strategy_session() returns a constant
 *   await db.unpinSession();                        // restores the migrated definition
 *   const a = await db.bootstrapAccount(OWNER);     // {accountId, instrumentId (EURUSD), riskId, observationId, strategyId}
 *   await db.actor(OWNER);                          // set role authenticated + request.jwt.claim.sub
 *   await db.actor(OWNER, "service_role");          // trusted server (bypassrls, still bound by grants)
 *   await db.anon();                                // set role anon, no subject
 *   await db.admin();                               // reset role: superuser, bypasses grants/RLS but not triggers
 *   await db.query<T>(sql, params); await db.exec(sql); db.pg  // the PGlite instance
 *   await db.addUser(id, email?); await db.close();
 *   migrationFiles(); readMigration(name)           // file names in apply order; raw source of one file
 *
 * Role and subject are session-scoped and persist until the next actor()/anon()/admin() call.
 * bootstrapAccount() leaves the session acting as the account owner. pinSession()/unpinSession() restore the
 * role and subject that were active before the call.
 * Stub objects: roles anon, authenticated, service_role (bypassrls); auth.users(id, email); auth.uid() reading
 * request.jwt.claim.sub; storage.buckets(id, name, public, file_size_limit, allowed_mime_types) and
 * storage.objects(id, bucket_id, name, owner, metadata) with RLS on and DML granted to the API roles.
 * Supabase default privileges are modelled as in scripts/local-stack/bootstrap.sql: every table, view, sequence and
 * function a migration creates in schema public starts out granted to anon, authenticated and service_role, so an
 * object whose migration forgets the §0.5 revoke stays exposed here exactly as it would on Supabase.
 */
import { PGlite, type Results } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export const OWNER = "10000000-0000-4000-8000-000000000001";
export const OTHER = "10000000-0000-4000-8000-000000000002";

export type ApiRole = "authenticated" | "anon" | "service_role";
export type StrategySession = "ACTIVE_KILL_ZONE" | "DEAD_POOL" | "ASIA" | "JUDAS";

export interface BootstrappedAccount {
  accountId: string;
  instrumentId: string;
  riskId: string;
  observationId: string;
  strategyId: string;
}

export interface MigrationRange {
  /** Inclusive numeric prefix bound, e.g. "0014". */
  upTo?: string;
}

const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url);

const STUB_SQL = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema storage;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/** All migration file names in the order they are applied. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
}

/** Source text of one migration file, exactly as checked out. */
export function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
}

function migrationPrefix(name: string): string {
  return name.slice(0, name.indexOf("_"));
}

export class TestDatabase {
  readonly pg: PGlite;
  private readonly applied = new Set<string>();
  private originalSessionSource: string | null = null;

  constructor(pg: PGlite) {
    this.pg = pg;
  }

  query<T>(sql: string, params?: unknown[]): Promise<Results<T>> {
    return this.pg.query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  /** Applies not-yet-applied migrations in lexical order, optionally only up to a numeric prefix. */
  async applyMigrations(range: MigrationRange = {}): Promise<string[]> {
    const pending = migrationFiles().filter(
      (name) =>
        !this.applied.has(name) &&
        (range.upTo === undefined || migrationPrefix(name).localeCompare(range.upTo, undefined, { numeric: true }) <= 0),
    );
    await this.admin();
    for (const name of pending) {
      await this.pg.exec(readMigration(name));
      this.applied.add(name);
    }
    return pending;
  }

  async actor(id: string, role: ApiRole = "authenticated"): Promise<void> {
    await this.pg.exec(`reset role; set role ${role};`);
    await this.pg.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  }

  anon(): Promise<void> {
    return this.actor("", "anon");
  }

  async admin(): Promise<void> {
    await this.pg.exec("reset role");
  }

  async addUser(id: string, email = `${id}@example.test`): Promise<void> {
    await this.withAdmin(() => this.pg.query("insert into auth.users(id, email) values ($1, $2)", [id, email]));
  }

  /** Pins the UTC−5 session classification used by the risk engine (production code keeps clock_timestamp()). */
  async pinSession(session: StrategySession): Promise<void> {
    await this.withAdmin(async () => {
      if (this.originalSessionSource === null) {
        const { rows } = await this.pg.query<{ src: string }>(
          "select prosrc as src from pg_proc where oid = 'private.strategy_session(timestamptz)'::regprocedure",
        );
        this.originalSessionSource = rows[0].src;
      }
      await this.pg.exec(
        `create or replace function private.strategy_session(p_now timestamptz) returns text language sql immutable set search_path = '' as $$ select '${session}'::text $$;`,
      );
    });
  }

  async unpinSession(): Promise<void> {
    const source = this.originalSessionSource;
    if (source === null) return;
    await this.withAdmin(() =>
      this.pg.exec(
        `create or replace function private.strategy_session(p_now timestamptz) returns text language sql immutable set search_path = '' as $session$${source}$session$;`,
      ),
    );
    this.originalSessionSource = null;
  }

  /** Creates a V1 demo account (USD, EURUSD/GBPUSD, Risk Plan V1.0, ICT V1.0) through bootstrap_demo_account. */
  async bootstrapAccount(
    userId: string,
    options: { name?: string; equity?: string; balance?: string } = {},
  ): Promise<BootstrappedAccount> {
    await this.actor(userId);
    const { rows } = await this.pg.query<{ id: string }>(
      "select public.bootstrap_demo_account($1, $2, $3, $4) as id",
      [randomUUID(), options.name ?? "Test account", options.equity ?? "10000", options.balance ?? "10000"],
    );
    const accountId = rows[0].id;
    const ids = await this.pg.query<Omit<BootstrappedAccount, "accountId">>(
      `select (select id from public.instrument_versions where account_id = $1 and symbol = 'EURUSD') as "instrumentId",
              (select id from public.risk_plan_versions where account_id = $1) as "riskId",
              (select id from public.account_observations where account_id = $1) as "observationId",
              (select id from public.strategy_versions where account_id = $1) as "strategyId"`,
      [accountId],
    );
    return { accountId, ...ids.rows[0] };
  }

  async close(): Promise<void> {
    await this.pg.close();
  }

  /** Runs fn as superuser and restores the previous role and subject. */
  private async withAdmin<T>(fn: () => Promise<T>): Promise<T> {
    const { rows } = await this.pg.query<{ role: string; sub: string | null }>(
      "select current_user::text as role, current_setting('request.jwt.claim.sub', true) as sub",
    );
    const previous = rows[0];
    await this.admin();
    try {
      return await fn();
    } finally {
      if (previous.role === "anon" || previous.role === "authenticated" || previous.role === "service_role") {
        await this.actor(previous.sub ?? "", previous.role);
      }
    }
  }
}

/** Creates a fresh in-memory database with the Supabase-like stub and the given auth users. */
export async function createTestDatabase(users: string[] = [OWNER, OTHER]): Promise<TestDatabase> {
  const pg = new PGlite();
  await pg.exec(STUB_SQL);
  const db = new TestDatabase(pg);
  for (const id of users) await db.addUser(id);
  return db;
}
