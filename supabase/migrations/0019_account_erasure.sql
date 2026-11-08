-- Trading OS V2: owner-requested erasure and final privilege hygiene (docs/V2_ARCHITECTURE.md §10.1, §10.3, §10.4).
-- MUST stay the last migration: the TRUNCATE guards, the privilege revokes, the foreign-key lookup indexes and the
-- purge's catalog-driven delete order cover every object that exists when this file runs, including the tables and
-- views of 0016-0018.
-- History stays append-only for everyone else. The only delete path is public.purge_user_trading_data(uuid, text),
-- which removes one user's rows in one transaction and rolls everything back when any of them remains. Only the
-- trusted server (service_role) can execute it, after the server action re-authenticated the session user: no access
-- token of a user, however fresh its password sign-in, can call any purge function.

-- ---------------------------------------------------------------------------------------------------------
-- Immutability with one scoped exception. create or replace keeps the function's OID, so every existing
-- immutable/immutable_record trigger runs this body. A DELETE passes only while the transaction-local setting
-- trading_os.erase_user_id names the row's owner. Only purge_user_trading_data sets it, and no API role holds a
-- DELETE grant on any table. UPDATE is never allowed; every other case raises the original message.
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_erasing text := coalesce(pg_catalog.current_setting('trading_os.erase_user_id', true), '');
begin
  if tg_op = 'DELETE' and v_erasing <> '' and pg_catalog.to_jsonb(old) ->> 'user_id' = v_erasing then
    return old;
  end if;
  raise exception 'Immutable record: append an event or create a new version.';
end $$;

-- TRUNCATE skips row-level triggers, so immutable tables also get a statement-level guard (installed below).
create function private.reject_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'TRUNCATE_FORBIDDEN: Trading OS records are append-only and cannot be truncated.';
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- De-identified erasure receipts: when, and how many rows per table; never who (no user id, no email).
-- Outside the API schemas; no role but the owner can read or write it.
-- ---------------------------------------------------------------------------------------------------------
create table private.erasure_receipts (
  id uuid primary key default gen_random_uuid(),
  erased_at timestamptz not null default clock_timestamp(),
  table_counts jsonb not null check (jsonb_typeof(table_counts) = 'object')
);
revoke all on private.erasure_receipts from public, anon, authenticated, service_role;
create trigger immutable_record before update or delete on private.erasure_receipts
  for each row execute function private.reject_mutation();

-- Every public table with a user_id column, by name (partitions are reached through their parent).
create function private.tenant_tables() returns regclass[]
language sql stable set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(c.oid::regclass order by c.relname), '{}')
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
     and exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped)
$$;

-- Deletes one user's rows of one table. Any foreign-key or immutability failure becomes PURGE_INCOMPLETE.
create function private.erase_rows(p_table regclass, p_user_id uuid) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_deleted bigint;
begin
  execute pg_catalog.format('delete from %s where user_id = $1', p_table) using p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when foreign_key_violation or restrict_violation or raise_exception then
  raise exception 'PURGE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Lookup indexes for the purge's foreign-key checks. Deleting a referenced row makes PostgreSQL search the
-- referencing table for rows that still point at it. Unless an index starts with foreign-key columns that identify
-- the referenced row, every deleted row scans that table (all users' rows): an active user's erasure then grows
-- quadratically and hits the API statement timeout on every retry. Each foreign key into a
-- tenant table without such an index gets one on just the columns that reference the parent's smallest unique key
-- (in practice its primary key). Narrow on purpose: an index that also carried user_id and account_id could
-- out-match a parent's unique key when the planner has no statistics yet.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_fk record;
  v_parent_key int2[];
  v_columns text;
begin
  for v_fk in
    select k.conrelid, k.confrelid, k.conkey, k.confkey, n.nspname, c.relname
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where k.contype = 'f' and k.confrelid = any (private.tenant_tables())
     order by n.nspname, c.relname, k.conname
  loop
    -- Indexed: the leading columns of some index are foreign-key columns that reference a whole unique key.
    continue when exists (
      select 1
        from pg_catalog.pg_index i
       cross join lateral pg_catalog.generate_series(1, i.indnkeyatts) as p(len)
       where i.indrelid = v_fk.conrelid and i.indisvalid and i.indpred is null
         and (i.indkey::int2[])[0:p.len - 1] <@ v_fk.conkey
         and exists (
           select 1 from pg_catalog.pg_index u
            where u.indrelid = v_fk.confrelid and u.indisunique and u.indisvalid and u.indpred is null and u.indexprs is null
              and (u.indkey::int2[])[0:u.indnkeyatts - 1] <@ array(
                    select v_fk.confkey[pg_catalog.array_position(v_fk.conkey, col)]
                      from pg_catalog.unnest((i.indkey::int2[])[0:p.len - 1]) as col)));
    select (u.indkey::int2[])[0:u.indnkeyatts - 1] into v_parent_key
      from pg_catalog.pg_index u
     where u.indrelid = v_fk.confrelid and u.indisunique and u.indisvalid and u.indpred is null and u.indexprs is null
       and (u.indkey::int2[])[0:u.indnkeyatts - 1] <@ v_fk.confkey
     order by u.indnkeyatts, u.indisprimary desc, u.indexrelid::regclass::text
     limit 1;
    select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' order by pg_catalog.array_position(v_parent_key, fk_column.parent_attnum))
      into v_columns
      from rows from (pg_catalog.unnest(v_fk.conkey), pg_catalog.unnest(v_fk.confkey)) as fk_column(attnum, parent_attnum)
      join pg_catalog.pg_attribute a on a.attrelid = v_fk.conrelid and a.attnum = fk_column.attnum
     where fk_column.parent_attnum = any (v_parent_key);
    execute pg_catalog.format('create index on %I.%I (%s)', v_fk.nspname, v_fk.relname, v_columns);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- public.purge_user_trading_data(p_user_id, p_confirm): deletes every row of one user from every public table that
-- has a user_id column. The delete order is computed from the catalog on each call (children before parents along
-- the foreign keys between those tables), so tables added by later migrations are covered without changing this
-- function; tables without user_id (evaluator_versions) are never touched. Storage objects are not touched here:
-- their paths are returned so the trusted server can delete them through the Storage API.
-- Service role only. The server action calls it with the secret key, for the session user, after the typed DELETE
-- and a password re-entry that signed in that same user (src/lib/erasure.ts). The database cannot tell that
-- re-authentication from a browser's own recent sign-in (both carry the same JWT amr claim), so no access token of a
-- user may execute it at all: the user comes from p_user_id, never from the caller's token.
-- Errors: INVALID_INPUT, CONFIRMATION_REQUIRED, AI_REQUEST_IN_PROGRESS, PURGE_INCOMPLETE: <table>.
-- ---------------------------------------------------------------------------------------------------------
create function public.purge_user_trading_data(p_user_id uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := p_user_id;
  v_legacy jsonb;
  v_evidence jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_pending regclass[];
  v_ready regclass[];
  v_table regclass;
  v_deleted bigint;
  v_leftover boolean;
begin
  if v_uid is null then raise exception 'INVALID_INPUT: A user id is required.'; end if;
  if p_confirm is distinct from 'ERASE ALL MY TRADING OS DATA' then
    raise exception 'CONFIRMATION_REQUIRED: Erasure requires the explicit confirmation phrase.';
  end if;
  -- The account rows are the serialization point of every account-scoped RPC (plans, slots, AI reservations).
  perform 1 from public.accounts a where a.user_id = v_uid order by a.id for update;
  -- A dispatched AI request settles its usage within the 10-30 minute request deadlines; erasing it first would
  -- leave provider spend unaccounted.
  if exists (select 1 from public.ai_request_reservations r
              where r.user_id = v_uid and r.created_at > clock_timestamp() - interval '30 minutes'
                and not exists (select 1 from public.ai_usage_records u where u.reservation_id = r.id)) then
    raise exception 'AI_REQUEST_IN_PROGRESS: An AI request of this user is still running; retry once it has finished.';
  end if;
  select coalesce(jsonb_agg(s.storage_path order by s.storage_path), '[]'::jsonb) into v_legacy
    from public.setup_screenshots s where s.user_id = v_uid;
  select coalesce(jsonb_agg(e.storage_path order by e.storage_path), '[]'::jsonb) into v_evidence
    from public.trade_evidence e where e.user_id = v_uid;

  v_pending := private.tenant_tables();
  perform pg_catalog.set_config('trading_os.erase_user_id', v_uid::text, true);
  while cardinality(v_pending) > 0 loop
    -- Ready: no other pending table references it. A self-reference (trades.duplicated_from) is satisfied within
    -- one statement because all of the user's rows of that table go together.
    select coalesce(array_agg(p.rel order by p.ord), '{}') into v_ready
      from unnest(v_pending) with ordinality as p(rel, ord)
     where not exists (select 1 from pg_catalog.pg_constraint k
                        where k.contype = 'f' and k.confrelid = p.rel and k.conrelid <> p.rel
                          and k.conrelid = any (v_pending));
    if cardinality(v_ready) > 0 then
      foreach v_table in array v_ready loop
        v_deleted := private.erase_rows(v_table, v_uid);
        v_counts := v_counts || jsonb_build_object((select c.relname from pg_catalog.pg_class c where c.oid = v_table), v_deleted);
        v_total := v_total + v_deleted;
      end loop;
      v_pending := array(select p.rel from unnest(v_pending) with ordinality as p(rel, ord)
                          where p.rel <> all (v_ready) order by p.ord);
    else
      -- Only a foreign-key cycle among the pending tables gets here: the first table whose rows nothing references
      -- any more goes next. Rows that reference each other around the cycle cannot go table by table: fail closed.
      v_deleted := null;
      foreach v_table in array v_pending loop
        begin
          v_deleted := private.erase_rows(v_table, v_uid);
          exit;
        exception when raise_exception then
          v_deleted := null;
        end;
      end loop;
      if v_deleted is null then
        raise exception 'PURGE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = v_pending[1]);
      end if;
      v_counts := v_counts || jsonb_build_object((select c.relname from pg_catalog.pg_class c where c.oid = v_table), v_deleted);
      v_total := v_total + v_deleted;
      v_pending := array_remove(v_pending, v_table);
    end if;
  end loop;
  perform pg_catalog.set_config('trading_os.erase_user_id', '', true);

  -- Fail closed: anything still owned by the user (a re-inserting trigger, a concurrent insert, a table the order
  -- could not reach) rolls the whole erasure back.
  foreach v_table in array private.tenant_tables() loop
    execute pg_catalog.format('select exists (select 1 from %s where user_id = $1)', v_table) using v_uid into v_leftover;
    if v_leftover then
      raise exception 'PURGE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = v_table);
    end if;
  end loop;

  -- A re-run that finds nothing (the erasure already happened) leaves no second receipt.
  if v_total > 0 then
    insert into private.erasure_receipts(table_counts) values (v_counts);
  end if;
  return jsonb_build_object('storagePaths', jsonb_build_object('legacy', v_legacy, 'evidence', v_evidence), 'deleted', v_counts);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Statement-level TRUNCATE guard on every public table that exists now (0001-0018) and on every immutable
-- private table (strategy templates, erasure receipts).
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_schema text;
  v_name text;
begin
  for v_schema, v_name in
    select n.nspname, c.relname
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and (n.nspname = 'public'
            or (n.nspname = 'private'
                and exists (select 1 from pg_catalog.pg_trigger t
                             where t.tgrelid = c.oid and t.tgfoid = 'private.reject_mutation()'::regprocedure)))
     order by 1, 2
  loop
    execute format('create or replace trigger truncate_guard before truncate on %I.%I for each statement execute function private.reject_truncate()',
      v_schema, v_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Table and view privileges under Supabase default privileges (§10.1, §10.3). API roles read through RLS and
-- write only through security-definer functions. The legacy setup evaluator (src/lib/setup-analysis.ts) still
-- inserts two tables directly with the secret key. No code registers legacy screenshots any more (V2 evidence goes
-- through register_trade_evidence), so setup_screenshots keeps no insert grant.
-- ---------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated, service_role;
grant insert on public.setup_evaluation_passes, public.evaluator_versions to service_role;
-- 0006 left journal_analytics with the default grants of authenticated and service_role; the app reads it only
-- with the user's session.
revoke all on public.journal_analytics from authenticated, service_role;
grant select on public.journal_analytics to authenticated;
-- Identity and serial values are drawn by security-definer functions as their owner; no API role needs a sequence.
revoke all on all sequences in schema public from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- V1 entry points that can create records outside the V2 trade model (§10.4). The V2 security-definer wrappers
-- (record_account_values, save_setup_proposal, check_setup_risk, lock_trade, ...) call them as their owner.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  public.lock_trade_plan(uuid, jsonb, uuid, uuid, uuid),
  public.evaluate_trade_plan(uuid, jsonb, uuid, uuid),
  public.import_locked_setup(uuid),
  public.create_risk_version(uuid, jsonb, boolean, text),
  public.record_observation(uuid, text, text, text),
  public.record_setup_decision(uuid, text, text)
  from public, anon, authenticated, service_role;

revoke all on function private.reject_mutation(), private.reject_truncate(), private.tenant_tables(),
  private.erase_rows(regclass, uuid) from public, anon, authenticated, service_role;
revoke all on function public.purge_user_trading_data(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.purge_user_trading_data(uuid, text) to service_role;

notify pgrst, 'reload schema';
