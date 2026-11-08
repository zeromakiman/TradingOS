import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, migrationFiles, OWNER, type TestDatabase } from "./helpers/pglite";

// docs/V2_ARCHITECTURE.md §0.5 and §10.1, asserted over every object of the final schema (all migrations
// present at run time), so tables and functions added by later migrations are covered automatically.

// Documented exceptions to "exactly one owner SELECT policy keyed on user_id = auth.uid()".
const POLICY_EXCEPTIONS: Record<string, string[]> = {
  // 0004: global evaluator prompts/schemas, readable by every signed-in user; the table has no user_id.
  evaluator_versions: ["authenticated_read"],
  // 0014: owner read plus the accounting operator's read-all policy used for incident resolution.
  ai_uncertainty_resolutions: ["operator_read", "owner_read"],
};
// 0004: global configuration, not tenant data (no user_id/account_id; erasure leaves it untouched).
const NON_TENANT_TABLES = new Set(["evaluator_versions"]);
// §3.11: the schema marker reads nothing and is deliberately SECURITY INVOKER.
const INVOKER_FUNCTIONS = new Set(["trading_os_schema"]);
// 0004: trusted-server RPCs that predate the p_user_id convention used to recognise service-only functions.
const SERVICE_ONLY_WITHOUT_USER_ARGUMENT = new Set(["start_setup_evaluation", "finish_setup_evaluation"]);
// §10.4: direct service-role inserts the legacy setup evaluator still performs after the 0019 DML revoke. V2 registers
// no legacy screenshots, so setup_screenshots keeps no insert grant.
const SERVICE_ROLE_INSERTS = new Set(["setup_evaluation_passes", "evaluator_versions"]);
// The TRUNCATE guard and the service_role DML revoke arrive with the erasure migration (§4, §10.4).
const ERASURE_MIGRATION_PRESENT = migrationFiles().some((name) => name.startsWith("0019_"));
// Under Supabase default privileges (modelled by the harness) two V1 leftovers stay granted until 0019's grant
// hygiene (§10.4) revokes them: authenticated keeps every privilege on journal_analytics (0006), and anon and
// authenticated keep these V1 sequences. Exactly these are exempt while 0019 is absent.
const PRE_ERASURE_VIEW_GRANTS = new Set(ERASURE_MIGRATION_PRESENT ? [] : ["journal_analytics"]);
const PRE_ERASURE_SEQUENCE_GRANTS = new Set(ERASURE_MIGRATION_PRESENT ? [] : [
  "setup_evaluation_events_id_seq", "setup_risk_checks_id_seq", "trade_events_sequence_seq", "trade_tag_revisions_id_seq",
]);

interface FunctionRow {
  schema: string; name: string; signature: string; definer: boolean; config: string[]; args: string[];
  is_trigger: boolean; anon: boolean; authenticated: boolean; service: boolean; public_execute: boolean;
}

let db: TestDatabase;
let tables: string[];
let functions: FunctionRow[];

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  await db.admin();
  tables = (await db.query<{ name: string }>(
    "select relname as name from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname")).rows.map((r) => r.name);
  functions = (await db.query<FunctionRow>(`
    select n.nspname as schema, p.proname as name, p.oid::regprocedure::text as signature, p.prosecdef as definer,
           coalesce(p.proconfig, '{}') as config, coalesce(p.proargnames, '{}') as args, p.prorettype = 'trigger'::regtype as is_trigger,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
     order by 1, 3`)).rows;
}, 60_000);
beforeEach(async () => { await db.admin(); });
afterAll(async () => { await db.close(); });

describe("shared PGlite harness", () => {
  it("pins and restores the strategy session without changing the acting role", async () => {
    const session = async (instant: string) => {
      await db.admin();
      return (await db.query<{ session: string }>("select private.strategy_session($1::timestamptz) as session", [instant])).rows[0].session;
    };
    await db.actor(OWNER);
    await db.pinSession("DEAD_POOL");
    expect((await db.query<{ role: string; sub: string }>("select current_user::text as role, current_setting('request.jwt.claim.sub') as sub")).rows[0])
      .toEqual({ role: "authenticated", sub: OWNER });
    expect(await session("2026-09-05T14:00:00Z")).toBe("DEAD_POOL");
    await db.unpinSession();
    expect(await session("2026-09-05T14:00:00Z")).toBe("ACTIVE_KILL_ZONE");
    expect(await session("2026-09-05T17:00:00Z")).toBe("DEAD_POOL");
    expect(await session("2026-09-05T23:00:00Z")).toBe("ASIA");
  });

  it("models Supabase default privileges, so an object without the §0.5 revoke stays exposed", async () => {
    await db.exec("begin");
    try {
      await db.exec("create table public.forgotten_revoke(id bigint generated always as identity primary key)");
      const { rows } = await db.query<Record<string, boolean>>(`select
          has_table_privilege('anon', 'public.forgotten_revoke', 'SELECT') as anon_select,
          has_table_privilege('authenticated', 'public.forgotten_revoke', 'INSERT') as authenticated_insert,
          has_table_privilege('service_role', 'public.forgotten_revoke', 'DELETE') as service_delete,
          has_sequence_privilege('anon', 'public.forgotten_revoke_id_seq', 'USAGE') as anon_sequence`);
      expect(rows[0]).toEqual({ anon_select: true, authenticated_insert: true, service_delete: true, anon_sequence: true });
    } finally {
      await db.exec("rollback");
    }
  });
});

describe("migrations", () => {
  it("names every migration so the review tool can list it", () => {
    expect(migrationFiles().filter((name) => !/^\d+_[a-z_]+\.sql$/.test(name))).toEqual([]);
  });

  it("covers the V1 and V2 tables", () => {
    expect(tables).toEqual(expect.arrayContaining(["accounts", "trade_plans", "setup_proposals", "ai_uncertainty_resolutions", "trades", "trade_evidence", "external_loss_removals"]));
  });
});

describe("tables", () => {
  it("enables row-level security on every public table", async () => {
    const { rows } = await db.query<{ name: string }>("select relname as name from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity");
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("scopes every tenant table by user_id and account_id with a composite foreign key", async () => {
    const { rows } = await db.query<{ name: string; user_column: boolean; account_column: boolean; scoped_key: boolean }>(`
      select c.relname as name,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) as user_column,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'account_id' and not a.attisdropped) as account_column,
             exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'f'
                       and k.conkey @> array[(select attnum from pg_attribute where attrelid = c.oid and attname = 'user_id'),
                                             (select attnum from pg_attribute where attrelid = c.oid and attname = 'account_id')]) as scoped_key
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by c.relname`);
    const violations = rows
      .filter((r) => !NON_TENANT_TABLES.has(r.name))
      .filter((r) => !r.user_column || (r.name !== "accounts" && (!r.account_column || !r.scoped_key)))
      .map((r) => r.name);
    expect(violations).toEqual([]);
  });

  it("has exactly one owner SELECT policy per table, with documented exceptions", async () => {
    const { rows } = await db.query<{ table: string; name: string; cmd: string; roles: string[]; permissive: string; qual: string }>(
      "select tablename as table, policyname as name, cmd, roles::text[] as roles, permissive, coalesce(qual, '') as qual from pg_policies where schemaname = 'public' order by 1, 2");
    const violations: string[] = [];
    for (const table of tables) {
      const policies = rows.filter((p) => p.table === table);
      const exception = POLICY_EXCEPTIONS[table];
      if (exception) {
        if (JSON.stringify(policies.map((p) => p.name)) !== JSON.stringify(exception)) violations.push(`${table}: ${policies.map((p) => p.name).join(",")}`);
        continue;
      }
      const owner = policies[0];
      const isOwnerRead = policies.length === 1 && owner.cmd === "SELECT" && owner.permissive === "PERMISSIVE"
        && JSON.stringify(owner.roles) === JSON.stringify(["authenticated"]) && /user_id\s*=/.test(owner.qual) && owner.qual.includes("auth.uid()");
      if (!isOwnerRead) violations.push(`${table}: ${JSON.stringify(policies)}`);
    }
    expect(violations).toEqual([]);
    expect(rows.find((p) => p.name === "authenticated_read")?.qual).toBe("true");
  });

  it("grants anon nothing and authenticated nothing beyond SELECT on tables and views", async () => {
    const { rows } = await db.query<{ name: string; role: string; privilege: string }>(`
      select c.relname as name, r.role, p.privilege
        from pg_class c
       cross join unnest(array['anon', 'authenticated']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege(r.role, c.oid, p.privilege)
       order by 1, 2, 3`);
    const violations = rows.filter((r) => r.role === "anon" || r.privilege !== "SELECT");
    expect(violations.filter((r) => !(r.role === "authenticated" && PRE_ERASURE_VIEW_GRANTS.has(r.name)))).toEqual([]);
    expect(rows.filter((r) => r.role === "authenticated").map((r) => r.name)).toEqual(expect.arrayContaining(["trades", "trade_ledger"]));
  });

  it("makes every table immutable through private.reject_mutation", async () => {
    const { rows } = await db.query<{ name: string; update_guard: boolean; delete_guard: boolean }>(`
      select c.relname as name,
             coalesce(bool_or(t.tgtype & 1 = 1 and t.tgtype & 2 = 2 and t.tgtype & 16 = 16), false) as update_guard,
             coalesce(bool_or(t.tgtype & 1 = 1 and t.tgtype & 2 = 2 and t.tgtype & 8 = 8), false) as delete_guard
        from pg_class c
        left join pg_trigger t on t.tgrelid = c.oid and not t.tgisinternal and t.tgfoid = 'private.reject_mutation()'::regprocedure
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       group by c.relname order by 1`);
    expect(rows.filter((r) => !r.update_guard || !r.delete_guard).map((r) => r.name)).toEqual([]);
  });

  it.runIf(ERASURE_MIGRATION_PRESENT)("guards every table against TRUNCATE with a statement-level trigger", async () => {
    const { rows } = await db.query<{ name: string }>(`
      select c.relname as name from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
                           and t.tgtype & 32 = 32 and t.tgtype & 2 = 2 and t.tgtype & 1 = 0)
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it.runIf(ERASURE_MIGRATION_PRESENT)("revokes service_role DML except the documented legacy inserts", async () => {
    const { rows } = await db.query<{ name: string; privilege: string }>(`
      select c.relname as name, p.privilege
        from pg_class c cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(privilege)
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege('service_role', c.oid, p.privilege)
       order by 1, 2`);
    expect(rows.filter((r) => !(r.privilege === "INSERT" && SERVICE_ROLE_INSERTS.has(r.name)))).toEqual([]);
  });

  it("keeps every view security_invoker", async () => {
    const { rows } = await db.query<{ name: string; options: string[] | null }>(
      "select relname as name, reloptions as options from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' order by 1");
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["journal_analytics", "trade_ledger"]));
    expect(rows.filter((r) => !(r.options ?? []).includes("security_invoker=true")).map((r) => r.name)).toEqual([]);
  });

  it("grants anon and authenticated nothing on public sequences", async () => {
    const { rows } = await db.query<{ name: string; role: string }>(`
      select c.relname as name, r.role from pg_class c
       cross join unnest(array['anon', 'authenticated']) as r(role)
       cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(privilege)
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.privilege)`);
    expect(rows.filter((r) => !PRE_ERASURE_SEQUENCE_GRANTS.has(r.name))).toEqual([]);
  });
});

describe("functions", () => {
  it("defines every public function as SECURITY DEFINER, with documented invoker exceptions", () => {
    const publicFunctions = functions.filter((f) => f.schema === "public");
    expect(publicFunctions.length).toBeGreaterThan(40);
    expect(publicFunctions.filter((f) => !f.definer && !INVOKER_FUNCTIONS.has(f.name)).map((f) => f.signature)).toEqual([]);
  });

  it("pins an empty search_path on every security-definer function", () => {
    expect(functions.filter((f) => f.definer && !f.config.includes('search_path=""')).map((f) => f.signature)).toEqual([]);
  });

  it("grants no function to anon or PUBLIC", () => {
    expect(functions.filter((f) => f.anon || f.public_execute).map((f) => f.signature)).toEqual([]);
  });

  it("keeps service-only functions away from authenticated users", () => {
    const serviceOnly = functions.filter((f) => f.schema === "public" && (f.args.includes("p_user_id") || SERVICE_ONLY_WITHOUT_USER_ARGUMENT.has(f.name)));
    expect(serviceOnly.map((f) => f.name)).toEqual(expect.arrayContaining(["register_trade_evidence", "reserve_account_ai_request", "start_trade_ai_review"]));
    expect(serviceOnly.filter((f) => f.authenticated || !f.service).map((f) => f.signature)).toEqual([]);
  });

  it("keeps private functions unreachable from every API role", () => {
    expect(functions.filter((f) => f.schema === "private" && (f.authenticated || f.service)).map((f) => f.signature)).toEqual([]);
  });

  it("exposes the V2 RPCs to authenticated users only", () => {
    const v2 = ["create_trading_account", "create_planned_trade", "lock_trade", "record_live_trade", "close_live_trade", "add_journal_entry",
      "set_trade_tags", "add_external_loss", "create_risk_policy_version", "trading_os_schema"];
    for (const name of v2) {
      const fn = functions.find((f) => f.schema === "public" && f.name === name);
      expect(fn, name).toMatchObject({ authenticated: true, anon: false, service: false, public_execute: false });
    }
  });
});
