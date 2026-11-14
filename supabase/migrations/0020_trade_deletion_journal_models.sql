-- Trading OS V2.1: deleted trades, permanent trade and trading-account deletion, custom journal models
-- (docs/V2_ARCHITECTURE.md §0.5, §3.12, §3.13, §10.4).
-- Additive only: 0001-0019 are unchanged. This file runs after 0019, so it installs for its own tables what 0019
-- installed for every table that existed then: RLS with one owner read policy, the immutability trigger, the
-- TRUNCATE guard, foreign-key lookup indexes, no DML grant to any API role and explicit function grants.
--
-- 1. Deleted trades. A trade is in Deleted trades while its latest trade_trash_events row is TRASHED. It is hidden from
--    every screen that reads trade_ledger through the app's filter, but nothing about it changes: private.daily_usage
--    and the Risk Engine read the base tables and count it exactly as before. Locked and live trades cannot be moved
--    to Deleted trades. Restore appends a RESTORED event.
-- 2. Permanent deletion. Only a trade in Deleted trades, only by its owner, only when it does not count toward the
--    current strategy day's usage (private.trade_counts_today mirrors the inputs of private.daily_usage), when no other
--    trade was duplicated from it and when no AI request of its account is in flight. One transaction removes every
--    per-trade row, children before parents, while the transaction-local flag trading_os.delete_scope names the owner
--    (private.reject_mutation lets a DELETE through only for rows of that user), then checks that nothing of the trade
--    is left and returns the storage paths for the trusted server. AI spend records (reservations, dispatches,
--    generations, usage, resolutions) are never deleted: their foreign keys run from the AI results to the
--    reservation, so a result can go while its spend stays.
-- 3. Trading-account deletion applies every permanent-deletion guard to each trade of the account first, so it is
--    never a way around them, and refuses while the account has AI history (its spend is kept, so archive instead).
-- 4. Custom models: per-account names a trader records live-first trades with. They are stored apart from the trade's
--    entry_model, which stays OB_FIRST_TOUCH / OTE / OTHER: the Risk Engine, the proposal schema and every AI context
--    keep reading only that. A trade with a custom model has entry_model OTHER (or unknown).
-- The erasure path (purge_user_trading_data and trading_os.erase_user_id) is unchanged.

-- ---------------------------------------------------------------------------------------------------------
-- Immutability with two scoped exceptions. create or replace keeps the OID, so every existing trigger runs this body.
-- trading_os.erase_user_id is set only by purge_user_trading_data (0019, service role only); trading_os.delete_scope is
-- set only by the owner-checked deletion functions below, always to auth.uid(), and cleared before they return.
-- UPDATE is never allowed.
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_erasing text := coalesce(pg_catalog.current_setting('trading_os.erase_user_id', true), '');
  v_scope text := coalesce(pg_catalog.current_setting('trading_os.delete_scope', true), '');
  v_owner text;
begin
  if tg_op = 'DELETE' then
    v_owner := pg_catalog.to_jsonb(old) ->> 'user_id';
    if (v_erasing <> '' and v_owner = v_erasing) or (v_scope <> '' and v_owner = v_scope) then
      return old;
    end if;
  end if;
  raise exception 'Immutable record: append an event or create a new version.';
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------------------------------------
create table public.trade_trash_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  event text not null check (event in ('TRASHED','RESTORED')),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);
create index trade_trash_events_latest on public.trade_trash_events(trade_id, id desc);

create table public.custom_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  unique (user_id, account_id, id),
  unique (user_id, request_key),
  foreign key (user_id, account_id) references public.accounts(user_id, id)
);
create index custom_models_account on public.custom_models(account_id, created_at);

-- Append-only revisions; the latest id wins.
create table public.custom_model_revisions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  account_id uuid not null,
  model_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 60 and name = btrim(name)),
  description text check (description is null or length(btrim(description)) between 1 and 500),
  status text not null check (status in ('ACTIVE','ARCHIVED')),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, model_id) references public.custom_models(user_id, account_id, id)
);
create index custom_model_revisions_latest on public.custom_model_revisions(model_id, id desc);

-- The trade's custom model: the latest row wins; a null model_id clears it.
create table public.trade_custom_models (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  model_id uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, model_id) references public.custom_models(user_id, account_id, id)
);
create index trade_custom_models_latest on public.trade_custom_models(trade_id, id desc);
create index trade_custom_models_model on public.trade_custom_models(model_id);

do $$
declare t text;
begin
  foreach t in array array['trade_trash_events','custom_models','custom_model_revisions','trade_custom_models'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy read_own on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create trigger immutable_record before update or delete on public.%I for each row execute function private.reject_mutation()', t);
    execute format('create trigger truncate_guard before truncate on public.%I for each statement execute function private.reject_truncate()', t);
  end loop;
end $$;
revoke all on sequence public.trade_trash_events_id_seq, public.custom_model_revisions_id_seq, public.trade_custom_models_id_seq
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- §3.12 Ledger columns, appended: trashed_at (the latest trash event, when it is TRASHED), custom_model_id and
-- custom_model_name (the latest assignment of a live-first or imported trade whose entry model is OTHER or unknown;
-- a trade classified OB first touch or OTE never shows a custom model). The view is rebuilt from its stored
-- definition (as 0018 does), so every existing column keeps exactly what the earlier migrations define.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_search_path constant text := pg_catalog.current_setting('search_path');
  v_column constant text := ' AS ai_review_count';
  v_definition text;
begin
  perform pg_catalog.set_config('search_path', '', true);
  v_definition := pg_catalog.rtrim(pg_catalog.pg_get_viewdef('public.trade_ledger'::pg_catalog.regclass), ';');
  if pg_catalog.array_length(pg_catalog.string_to_array(v_definition, v_column), 1) is distinct from 2 then
    raise exception 'LEDGER_DEFINITION_CHANGED: trade_ledger.ai_review_count is not found exactly once';
  end if;
  execute 'create or replace view public.trade_ledger with (security_invoker = true) as '
    || pg_catalog.replace(v_definition, v_column, v_column
         || ', (select case when trash.event = ''TRASHED'' then trash.recorded_at end from public.trade_trash_events trash'
         || ' where trash.trade_id = t.id order by trash.id desc limit 1) as trashed_at'
         || ', case when t.origin <> ''PLANNED'' and coalesce(facts.entry_model, ''OTHER'') = ''OTHER'' then'
         || ' (select assignment.model_id from public.trade_custom_models assignment where assignment.trade_id = t.id'
         || ' order by assignment.id desc limit 1) end as custom_model_id'
         || ', case when t.origin <> ''PLANNED'' and coalesce(facts.entry_model, ''OTHER'') = ''OTHER'' then'
         || ' (select (select revision.name from public.custom_model_revisions revision where revision.model_id = assignment.model_id'
         || ' order by revision.id desc limit 1) from public.trade_custom_models assignment where assignment.trade_id = t.id'
         || ' order by assignment.id desc limit 1) end as custom_model_name');
  perform pg_catalog.set_config('search_path', v_search_path, true);
end $$;
revoke all on public.trade_ledger from public, anon, authenticated, service_role;
grant select on public.trade_ledger to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Private helpers.
-- ---------------------------------------------------------------------------------------------------------

-- Whether a trade counts toward the usage of p_now's strategy day, mirroring the inputs of private.daily_usage (0016):
-- its plan was locked for that day (slot and planned risk), it is still open (a plan without outcome executed
-- earlier, or a live-first/imported trade without close), its entry is on that day, or its exit is on that day
-- (realized loss). A trade that counts cannot be deleted permanently until the next strategy day (00:00 UTC−5).
create function private.trade_counts_today(p_trade_id uuid, p_now timestamptz) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_day date := private.strategy_day(p_now);
  t public.trades;
  p public.trade_plans;
  f public.trade_position_facts;
  c public.trade_unplanned_closes;
begin
  select * into t from public.trades where id = p_trade_id;
  if not found then return false; end if;
  select tp.* into p from public.trade_plan_links l join public.trade_plans tp on tp.id = l.plan_id where l.trade_id = t.id;
  if p.id is not null then
    if p.trading_day = v_day then return true; end if;
    if exists (select 1 from public.trade_executions e where e.plan_id = p.id)
       and not exists (select 1 from public.trade_outcomes o where o.plan_id = p.id) then
      return true;
    end if;
    if exists (select 1 from public.trade_outcomes o where o.plan_id = p.id and private.strategy_day(o.exited_at) = v_day) then
      return true;
    end if;
  end if;
  if t.origin in ('LIVE_FIRST','IMPORTED') then
    select * into c from public.trade_unplanned_closes where trade_id = t.id;
    if c.trade_id is null then return true; end if;
    if private.strategy_day(c.exited_at) = v_day then return true; end if;
    f := private.effective_position(t.id);
    if private.strategy_day(coalesce(f.entered_at,
         (select min(x.recorded_at) from public.trade_position_facts x where x.trade_id = t.id))) = v_day then
      return true;
    end if;
  end if;
  return false;
end $$;

-- Whether an AI request of the account is still in flight: a reservation without usage record younger than 30 minutes
-- (the purge's rule, 0019). Account-wide on purpose: a request reserves before its own records exist.
create function private.account_ai_in_flight(p_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.ai_request_reservations r
                  where r.account_id = p_account_id and r.created_at > clock_timestamp() - interval '30 minutes'
                    and not exists (select 1 from public.ai_usage_records u where u.reservation_id = r.id))
$$;

create function private.trade_trashed(p_trade_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select e.event = 'TRASHED' from public.trade_trash_events e where e.trade_id = p_trade_id order by e.id desc limit 1), false)
$$;

-- Every guard of a permanent deletion except "is in Deleted trades" (account deletion deletes all trades of the account).
create function private.require_trade_deletable(p_trade public.trades) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.trade_lifecycle(p_trade.id) in ('LOCKED','LIVE') then
    raise exception 'TRADE_OPEN: Close, skip or cancel this trade first';
  end if;
  if private.trade_counts_today(p_trade.id, clock_timestamp()) then
    raise exception 'TRADE_COUNTS_TODAY: This trade counts toward today''s limits';
  end if;
  if private.account_ai_in_flight(p_trade.account_id) then
    raise exception 'AI_REQUEST_IN_PROGRESS: An AI request of this trading account is still running';
  end if;
end $$;

-- Deletes every per-trade row of one trade, children before parents. The caller holds the account and trade row locks
-- and has set trading_os.delete_scope to the owner. Returns {legacy:[paths], evidence:[paths]} of the trade's storage
-- objects and the deleted row counts. Raises DELETE_INCOMPLETE when any row of the trade remains (whole transaction
-- rolls back). Risk evaluations are deleted only when nothing else references them; AI reservations, dispatches,
-- generations, usage records and resolutions are never touched.
create function private.delete_trade_rows(p_trade public.trades) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_trade uuid := p_trade.id;
  v_user uuid := p_trade.user_id;
  v_plan uuid;
  v_proposals uuid[];
  v_evaluations uuid[];
  v_setup_evaluations uuid[];
  v_legacy jsonb;
  v_evidence jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
  v_table record;
  v_leftover boolean;
begin
  if pg_catalog.current_setting('trading_os.delete_scope', true) is distinct from v_user::text then
    raise exception 'DELETE_SCOPE_REQUIRED: deletion scope is not set for this user';
  end if;
  select l.plan_id into v_plan from public.trade_plan_links l where l.trade_id = v_trade;
  select coalesce(array_agg(distinct x.id), '{}') into v_proposals from (
    select r.proposal_id as id from public.trade_revisions r where r.trade_id = v_trade
    union select s.proposal_id from public.setup_locks s where v_plan is not null and s.plan_id = v_plan
  ) x;
  select coalesce(array_agg(distinct x.id), '{}') into v_evaluations from (
    select s.risk_evaluation_id as id from public.setup_proposals s where s.id = any (v_proposals)
    union select c.risk_evaluation_id from public.setup_risk_checks c where c.proposal_id = any (v_proposals)
    union select h.risk_evaluation_id from public.setup_human_decisions h where h.proposal_id = any (v_proposals)
    union select p.risk_evaluation_id from public.trade_plans p where p.id = v_plan
  ) x where x.id is not null;
  select coalesce(array_agg(e.id), '{}') into v_setup_evaluations from public.setup_evaluations e where e.proposal_id = any (v_proposals);
  select coalesce(jsonb_agg(s.storage_path order by s.storage_path), '[]'::jsonb) into v_legacy
    from public.setup_screenshots s where s.proposal_id = any (v_proposals) and s.user_id = v_user;
  select coalesce(jsonb_agg(e.storage_path order by e.storage_path), '[]'::jsonb) into v_evidence
    from public.trade_evidence e where e.trade_id = v_trade and e.user_id = v_user;

  -- AI results of the trade (never the spend records they point to).
  delete from public.trade_ai_review_results x using public.trade_ai_reviews a where x.review_id = a.id and a.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_ai_review_results', v_count);
  delete from public.trade_ai_reviews a where a.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_ai_reviews', v_count);
  delete from public.trade_timeline_review_results x using public.trade_timeline_reviews a where x.review_id = a.id and a.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_timeline_review_results', v_count);
  delete from public.trade_timeline_reviews a where a.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_timeline_reviews', v_count);
  delete from public.bias_challenge_results x using public.bias_challenges a where x.challenge_id = a.id and a.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('bias_challenge_results', v_count);
  delete from public.bias_challenges a where a.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('bias_challenges', v_count);
  -- Legacy setup evaluations and decisions of the trade's proposals.
  delete from public.setup_evaluation_screenshots x where x.evaluation_id = any (v_setup_evaluations) or x.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_evaluation_screenshots', v_count);
  delete from public.setup_evaluation_events x where x.evaluation_id = any (v_setup_evaluations);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_evaluation_events', v_count);
  delete from public.setup_evaluation_passes x where x.evaluation_id = any (v_setup_evaluations);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_evaluation_passes', v_count);
  delete from public.setup_human_decisions x where x.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_human_decisions', v_count);
  delete from public.setup_evaluations x where x.id = any (v_setup_evaluations);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_evaluations', v_count);
  -- Screenshots and evidence.
  delete from public.setup_screenshot_removals x where x.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_screenshot_removals', v_count);
  delete from public.setup_screenshots x where x.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_screenshots', v_count);
  delete from public.trade_evidence_labels x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_evidence_labels', v_count);
  delete from public.trade_evidence_removals x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_evidence_removals', v_count);
  delete from public.trade_evidence x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_evidence', v_count);
  -- Per-trade records.
  delete from public.trade_journal_entries x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_journal_entries', v_count);
  delete from public.trade_lifecycle_events x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_lifecycle_events', v_count);
  delete from public.trade_tag_sets x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_tag_sets', v_count);
  delete from public.trade_execution_links x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_execution_links', v_count);
  delete from public.trade_unplanned_closes x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_unplanned_closes', v_count);
  delete from public.trade_position_facts x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_position_facts', v_count);
  delete from public.trade_custom_models x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_custom_models', v_count);
  delete from public.trade_trash_events x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_trash_events', v_count);
  -- The plan and its V1 records.
  delete from public.trade_outcomes x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_outcomes', v_count);
  delete from public.trade_executions x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_executions', v_count);
  delete from public.trade_dispositions x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_dispositions', v_count);
  delete from public.trade_events x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_events', v_count);
  delete from public.trade_reviews x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_reviews', v_count);
  delete from public.trade_tag_revisions x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_tag_revisions', v_count);
  delete from public.plan_chart_assets x where x.plan_id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('plan_chart_assets', v_count);
  delete from public.setup_locks x where x.plan_id = v_plan or x.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_locks', v_count);
  delete from public.trade_plan_links x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_plan_links', v_count);
  delete from public.trade_revisions x where x.trade_id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_revisions', v_count);
  delete from public.trade_plans x where x.id = v_plan;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trade_plans', v_count);
  delete from public.setup_risk_checks x where x.proposal_id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_risk_checks', v_count);
  delete from public.setup_proposals x where x.id = any (v_proposals);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('setup_proposals', v_count);
  delete from public.risk_evaluations x
   where x.id = any (v_evaluations)
     and not exists (select 1 from public.setup_proposals s where s.risk_evaluation_id = x.id)
     and not exists (select 1 from public.setup_risk_checks c where c.risk_evaluation_id = x.id)
     and not exists (select 1 from public.setup_human_decisions h where h.risk_evaluation_id = x.id)
     and not exists (select 1 from public.trade_plans p where p.risk_evaluation_id = x.id);
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('risk_evaluations', v_count);
  delete from public.trades x where x.id = v_trade;
  get diagnostics v_count = row_count; v_counts := v_counts || jsonb_build_object('trades', v_count);

  -- Fail closed: no row of any public table may still name the trade, its plan or its proposals (tables added later
  -- with such a column are covered automatically).
  for v_table in
    select c.oid::regclass as rel, a.attname as col
      from pg_catalog.pg_class c
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
       and (a.attname in ('trade_id', 'plan_id', 'proposal_id') or (c.relname = 'trades' and a.attname = 'id'))
  loop
    if v_table.col in ('trade_id', 'id') then
      execute pg_catalog.format('select exists (select 1 from %s where %I = $1)', v_table.rel, v_table.col) using v_trade into v_leftover;
    elsif v_table.col = 'plan_id' then
      execute pg_catalog.format('select exists (select 1 from %s where %I = $1)', v_table.rel, v_table.col) using v_plan into v_leftover;
    else
      execute pg_catalog.format('select exists (select 1 from %s where %I = any ($1))', v_table.rel, v_table.col) using v_proposals into v_leftover;
    end if;
    if v_leftover then
      raise exception 'DELETE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = v_table.rel);
    end if;
  end loop;
  return jsonb_build_object('storagePaths', jsonb_build_object('legacy', v_legacy, 'evidence', v_evidence), 'deleted', v_counts);
end $$;

-- Deletes the rows of one account from one table. Any foreign-key or immutability failure becomes DELETE_INCOMPLETE.
create function private.delete_account_rows(p_table regclass, p_user_id uuid, p_account_id uuid) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_deleted bigint;
begin
  execute pg_catalog.format('delete from %s where user_id = $1 and account_id = $2', p_table) using p_user_id, p_account_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when foreign_key_violation or restrict_violation or raise_exception then
  raise exception 'DELETE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Deleted trades.
-- ---------------------------------------------------------------------------------------------------------
create function public.trash_trade(p_trade_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; e public.trade_trash_events;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  select * into e from public.trade_trash_events where trade_id = t.id order by id desc limit 1;
  if found and e.event = 'TRASHED' then
    return jsonb_build_object('tradeId', t.id, 'trashedAt', e.recorded_at);
  end if;
  if private.trade_lifecycle(t.id) in ('LOCKED','LIVE') then
    raise exception 'TRADE_OPEN: Close, skip or cancel this trade first';
  end if;
  insert into public.trade_trash_events(user_id, account_id, trade_id, event)
    values (t.user_id, t.account_id, t.id, 'TRASHED') returning * into e;
  return jsonb_build_object('tradeId', t.id, 'trashedAt', e.recorded_at);
end $$;

create function public.restore_trade(p_trade_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  if not private.trade_trashed(t.id) then
    raise exception 'TRADE_NOT_DELETED: This trade is not in Deleted trades';
  end if;
  insert into public.trade_trash_events(user_id, account_id, trade_id, event) values (t.user_id, t.account_id, t.id, 'RESTORED');
  return jsonb_build_object('tradeId', t.id, 'trashedAt', null);
end $$;

-- p_confirm must be 'DELETE' (the word the trader types).
create function public.delete_trade_permanently(p_trade_id uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; v_result jsonb;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  if p_confirm is distinct from 'DELETE' then
    raise exception 'CONFIRMATION_REQUIRED: Type DELETE to delete this trade permanently';
  end if;
  if not private.trade_trashed(t.id) then
    raise exception 'TRADE_NOT_DELETED: Move the trade to Deleted trades first';
  end if;
  if exists (select 1 from public.trades c where c.duplicated_from = t.id) then
    raise exception 'TRADE_HAS_COPIES: Another trade was duplicated from this one';
  end if;
  perform private.require_trade_deletable(t);
  perform pg_catalog.set_config('trading_os.delete_scope', t.user_id::text, true);
  v_result := private.delete_trade_rows(t);
  perform pg_catalog.set_config('trading_os.delete_scope', '', true);
  return v_result || jsonb_build_object('tradeId', t.id);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Trading-account deletion. p_confirm_name must equal the account's current name exactly. An account with trades
-- also needs p_delete_trades = true, and every trade must pass the permanent-deletion guards (not locked or live, not
-- counting toward today, no AI request in flight). AI history (reservations, V1 analysis attempts) is kept for
-- accounting, so such an account is archived instead. Returns the storage paths and the deleted trade ids.
-- ---------------------------------------------------------------------------------------------------------
create function public.delete_trading_account(p_account_id uuid, p_confirm_name text, p_delete_trades boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts;
  t public.trades;
  v_name text;
  v_trades jsonb;
  v_legacy jsonb;
  v_evidence jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_pending regclass[];
  v_ready regclass[];
  v_table regclass;
  v_deleted bigint;
  v_leftover boolean;
begin
  a := private.lock_owned_account(p_account_id);
  v_name := coalesce((select p.display_name from public.account_profiles p where p.account_id = a.id order by p.id desc limit 1), a.name);
  if p_confirm_name is null or p_confirm_name is distinct from v_name then
    raise exception 'CONFIRMATION_REQUIRED: Type the account name exactly to delete it';
  end if;
  if private.account_ai_in_flight(a.id) then
    raise exception 'AI_REQUEST_IN_PROGRESS: An AI request of this trading account is still running';
  end if;
  if exists (select 1 from public.ai_request_reservations r where r.account_id = a.id)
     or exists (select 1 from public.ai_analysis_attempts x where x.account_id = a.id) then
    raise exception 'ACCOUNT_HAS_AI_HISTORY: This account has AI usage history, which is kept; archive it instead';
  end if;
  if exists (select 1 from public.trades x where x.account_id = a.id) and p_delete_trades is not true then
    raise exception 'ACCOUNT_HAS_TRADES: This account has trades; confirm that they are deleted too';
  end if;
  for t in select * from public.trades x where x.account_id = a.id order by x.created_at, x.id for update loop
    if private.trade_lifecycle(t.id) in ('LOCKED','LIVE') then
      raise exception 'ACCOUNT_HAS_OPEN_TRADES: Close, skip or cancel the account''s open trades first';
    end if;
  end loop;
  for t in select * from public.trades x where x.account_id = a.id order by x.created_at, x.id loop
    perform private.require_trade_deletable(t);
  end loop;

  select coalesce(jsonb_agg(x.id order by x.id), '[]'::jsonb) into v_trades from public.trades x where x.account_id = a.id;
  select coalesce(jsonb_agg(s.storage_path order by s.storage_path), '[]'::jsonb) into v_legacy
    from public.setup_screenshots s where s.account_id = a.id and s.user_id = a.user_id;
  select coalesce(jsonb_agg(e.storage_path order by e.storage_path), '[]'::jsonb) into v_evidence
    from public.trade_evidence e where e.account_id = a.id and e.user_id = a.user_id;

  -- Every public table with user_id and account_id, children before parents (computed from the catalog, as the
  -- purge does), then the account row itself.
  select coalesce(array_agg(c.oid::regclass order by c.relname), '{}') into v_pending
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
     and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = c.oid and x.attname = 'user_id' and x.attnum > 0 and not x.attisdropped)
     and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = c.oid and x.attname = 'account_id' and x.attnum > 0 and not x.attisdropped);
  perform pg_catalog.set_config('trading_os.delete_scope', a.user_id::text, true);
  while cardinality(v_pending) > 0 loop
    select coalesce(array_agg(p.rel order by p.ord), '{}') into v_ready
      from unnest(v_pending) with ordinality as p(rel, ord)
     where not exists (select 1 from pg_catalog.pg_constraint k
                        where k.contype = 'f' and k.confrelid = p.rel and k.conrelid <> p.rel and k.conrelid = any (v_pending));
    if cardinality(v_ready) = 0 then
      raise exception 'DELETE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = v_pending[1]);
    end if;
    foreach v_table in array v_ready loop
      v_deleted := private.delete_account_rows(v_table, a.user_id, a.id);
      v_counts := v_counts || jsonb_build_object((select c.relname from pg_catalog.pg_class c where c.oid = v_table), v_deleted);
    end loop;
    v_pending := array(select p.rel from unnest(v_pending) with ordinality as p(rel, ord) where p.rel <> all (v_ready) order by p.ord);
  end loop;
  begin
    delete from public.accounts x where x.id = a.id and x.user_id = a.user_id;
  exception when foreign_key_violation or restrict_violation or raise_exception then
    raise exception 'DELETE_INCOMPLETE: accounts';
  end;
  v_counts := v_counts || jsonb_build_object('accounts', 1);
  perform pg_catalog.set_config('trading_os.delete_scope', '', true);

  foreach v_table in array array(
      select c.oid::regclass from pg_catalog.pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
         and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = c.oid and x.attname = 'account_id' and x.attnum > 0 and not x.attisdropped)) loop
    execute pg_catalog.format('select exists (select 1 from %s where account_id = $1)', v_table) using a.id into v_leftover;
    if v_leftover then
      raise exception 'DELETE_INCOMPLETE: %', (select c.relname from pg_catalog.pg_class c where c.oid = v_table);
    end if;
  end loop;
  return jsonb_build_object('accountId', a.id, 'tradeIds', v_trades,
    'storagePaths', jsonb_build_object('legacy', v_legacy, 'evidence', v_evidence), 'deleted', v_counts);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Custom models.
-- ---------------------------------------------------------------------------------------------------------

-- Names the Risk Engine's own models use are reserved (compared case-insensitively, spaces and "_" alike).
create function private.reserved_model_name(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(p_name)), '[\s_]+', ' ', 'g')
         in ('ob first touch', 'ote', 'other')
$$;

create function private.model_name_taken(p_account_id uuid, p_name text, p_except uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.reserved_model_name(p_name) or exists (
    select 1 from public.custom_models m
     cross join lateral (select r.name, r.status from public.custom_model_revisions r where r.model_id = m.id order by r.id desc limit 1) latest
     where m.account_id = p_account_id and m.id is distinct from p_except and latest.status = 'ACTIVE'
       and pg_catalog.lower(latest.name) = pg_catalog.lower(pg_catalog.btrim(p_name)))
$$;

create function private.model_name_input(p_input jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_name text := pg_catalog.btrim(private.json_text(p_input, 'name'));
begin
  if v_name is null or pg_catalog.length(v_name) not between 1 and 60 then
    raise exception 'INVALID_INPUT: name must contain 1 to 60 characters';
  end if;
  return v_name;
end $$;

create function private.model_description_input(p_input jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_description text := nullif(pg_catalog.btrim(private.json_text(p_input, 'description')), '');
begin
  if pg_catalog.length(v_description) > 500 then
    raise exception 'INVALID_INPUT: description must contain at most 500 characters';
  end if;
  return v_description;
end $$;

-- The caller's model, with its account row locked (name uniqueness is checked under that lock).
create function private.lock_owned_model(p_model_id uuid) returns public.custom_models
language plpgsql security definer set search_path = '' as $$
declare m public.custom_models;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into m from public.custom_models where id = p_model_id and user_id = auth.uid();
  if not found then raise exception 'MODEL_NOT_FOUND: Model not found'; end if;
  perform 1 from public.accounts where id = m.account_id for update;
  return m;
end $$;

-- {name, description?}. Idempotent per request key. Allowed on archived accounts (account configuration).
create function public.create_custom_model(p_account_id uuid, p_input jsonb, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts; m public.custom_models; r public.custom_model_revisions;
  v_name text; v_description text;
begin
  a := private.lock_owned_account(p_account_id);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  perform private.require_object(p_input, array['name','description'], 'model');
  v_name := private.model_name_input(p_input);
  v_description := private.model_description_input(p_input);
  select * into m from public.custom_models where user_id = a.user_id and request_key = p_request_key;
  if found then
    select * into r from public.custom_model_revisions where model_id = m.id order by id limit 1;
    if m.account_id <> a.id or r.name <> v_name or r.description is distinct from v_description then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different model';
    end if;
    return jsonb_build_object('modelId', m.id, 'revisionId', r.id, 'replayed', true);
  end if;
  if private.model_name_taken(a.id, v_name, null) then
    raise exception 'MODEL_NAME_TAKEN: A model with this name already exists in this account';
  end if;
  insert into public.custom_models(user_id, account_id, request_key) values (a.user_id, a.id, p_request_key) returning * into m;
  insert into public.custom_model_revisions(user_id, account_id, model_id, name, description, status)
    values (a.user_id, a.id, m.id, v_name, v_description, 'ACTIVE') returning * into r;
  return jsonb_build_object('modelId', m.id, 'revisionId', r.id, 'replayed', false);
end $$;

-- Any subset of {name, description, status}; missing keys copy the latest revision; unchanged input is a no-op.
create function public.revise_custom_model(p_model_id uuid, p_input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare m public.custom_models; cur public.custom_model_revisions; nxt public.custom_model_revisions; v_id bigint;
begin
  m := private.lock_owned_model(p_model_id);
  perform private.require_object(p_input, array['name','description','status'], 'model');
  select * into cur from public.custom_model_revisions where model_id = m.id order by id desc limit 1;
  nxt := cur;
  if p_input ? 'name' then nxt.name := private.model_name_input(p_input); end if;
  if p_input ? 'description' then nxt.description := private.model_description_input(p_input); end if;
  if p_input ? 'status' then
    nxt.status := private.json_text(p_input, 'status');
    if nxt.status is null or nxt.status not in ('ACTIVE','ARCHIVED') then
      raise exception 'INVALID_INPUT: status must be ACTIVE or ARCHIVED';
    end if;
  end if;
  if (nxt.name, nxt.description, nxt.status) is not distinct from (cur.name, cur.description, cur.status) then
    return cur.id;
  end if;
  if nxt.status = 'ACTIVE' and private.model_name_taken(m.account_id, nxt.name, m.id) then
    raise exception 'MODEL_NAME_TAKEN: A model with this name already exists in this account';
  end if;
  insert into public.custom_model_revisions(user_id, account_id, model_id, name, description, status)
    values (m.user_id, m.account_id, m.id, nxt.name, nxt.description, nxt.status) returning id into v_id;
  return v_id;
end $$;

-- Removes a model that was never assigned to any trade; an assigned model can only be archived.
create function public.delete_custom_model(p_model_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.custom_models;
begin
  m := private.lock_owned_model(p_model_id);
  if exists (select 1 from public.trade_custom_models x where x.model_id = m.id) then
    raise exception 'MODEL_IN_USE: This model was assigned to a trade; archive it instead';
  end if;
  perform pg_catalog.set_config('trading_os.delete_scope', m.user_id::text, true);
  delete from public.custom_model_revisions x where x.model_id = m.id;
  delete from public.custom_models x where x.id = m.id;
  perform pg_catalog.set_config('trading_os.delete_scope', '', true);
end $$;

-- Sets (or, with a null model, clears) the custom model of a live-first or imported trade whose entry model is OTHER
-- or not yet known. The model must be an active model of the trade's account. Idempotent.
create function public.set_trade_custom_model(p_trade_id uuid, p_model_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades; f public.trade_position_facts; cur public.trade_custom_models; v_status text; v_id bigint;
begin
  t := private.lock_owned_trade(p_trade_id, false);
  if t.origin = 'PLANNED' then
    raise exception 'MODEL_NOT_APPLICABLE: A planned trade keeps the model it was planned with';
  end if;
  f := private.effective_position(t.id);
  if f.entry_model is not null and f.entry_model <> 'OTHER' then
    raise exception 'MODEL_NOT_APPLICABLE: This trade is recorded with a Risk Engine model';
  end if;
  select * into cur from public.trade_custom_models where trade_id = t.id order by id desc limit 1;
  if found and cur.model_id is not distinct from p_model_id then
    return jsonb_build_object('tradeId', t.id, 'modelId', p_model_id, 'assignmentId', cur.id);
  end if;
  if p_model_id is not null then
    select (select r.status from public.custom_model_revisions r where r.model_id = m.id order by r.id desc limit 1) into v_status
      from public.custom_models m where m.id = p_model_id and m.user_id = t.user_id and m.account_id = t.account_id;
    if v_status is distinct from 'ACTIVE' then
      raise exception 'MODEL_NOT_AVAILABLE: This model is not an active model of the trade''s account';
    end if;
  elsif cur.id is null then
    return jsonb_build_object('tradeId', t.id, 'modelId', null, 'assignmentId', null);
  end if;
  insert into public.trade_custom_models(user_id, account_id, trade_id, model_id)
    values (t.user_id, t.account_id, t.id, p_model_id) returning id into v_id;
  return jsonb_build_object('tradeId', t.id, 'modelId', p_model_id, 'assignmentId', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.11 Schema marker.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.trading_os_schema() returns text
language sql stable security invoker set search_path = '' as $$ select '2.1'::text $$;

-- ---------------------------------------------------------------------------------------------------------
-- Function privileges: explicit revoke per signature, then the exact grant.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  private.reject_mutation(), private.trade_counts_today(uuid, timestamptz), private.account_ai_in_flight(uuid),
  private.trade_trashed(uuid), private.require_trade_deletable(public.trades), private.delete_trade_rows(public.trades),
  private.delete_account_rows(regclass, uuid, uuid), private.reserved_model_name(text), private.model_name_taken(uuid, text, uuid),
  private.model_name_input(jsonb), private.model_description_input(jsonb), private.lock_owned_model(uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  public.trash_trade(uuid), public.restore_trade(uuid), public.delete_trade_permanently(uuid, text),
  public.delete_trading_account(uuid, text, boolean), public.create_custom_model(uuid, jsonb, uuid),
  public.revise_custom_model(uuid, jsonb), public.delete_custom_model(uuid), public.set_trade_custom_model(uuid, uuid),
  public.trading_os_schema()
  from public, anon, service_role;
grant execute on function
  public.trash_trade(uuid), public.restore_trade(uuid), public.delete_trade_permanently(uuid, text),
  public.delete_trading_account(uuid, text, boolean), public.create_custom_model(uuid, jsonb, uuid),
  public.revise_custom_model(uuid, jsonb), public.delete_custom_model(uuid), public.set_trade_custom_model(uuid, uuid),
  public.trading_os_schema()
  to authenticated;

notify pgrst, 'reload schema';
