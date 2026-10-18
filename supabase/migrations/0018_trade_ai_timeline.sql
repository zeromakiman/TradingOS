-- Trading OS V2: AI on trade evidence and the timeline-aware trade review (docs/V2_ARCHITECTURE.md §11.3, §11.4).
-- Additive only. Part 1 replaces start_/authorize_bias_challenge with the same signatures: proposals that are not a
-- V2 draft revision keep the exact 0010 behaviour and messages. Part 2 adds REVIEW_TRADE_TIMELINE history (keyed by
-- trades.id, any origin) with service-only RPCs mirroring 0009/0010, the trade_ai_activity view, and counts completed
-- timeline reviews in trade_ledger.ai_review_count.
-- New errors start with a stable code prefix ('NOT_LATEST_REVISION: ...'); TypeScript maps them to human copy.

-- ---------------------------------------------------------------------------------------------------------
-- §11.3 Pre-trade AI on V2 drafts.
-- ---------------------------------------------------------------------------------------------------------
-- A proposal that is a V2 draft revision may only be analysed while its trade is a planned draft that is not
-- discarded and has no plan link, and only as the trade's latest revision. Locks the trade row after the caller's
-- account lock, the order every 0015 RPC uses, so a concurrent revision or lock is serialised with the request.
create function private.require_current_draft(p_trade_id uuid, p_proposal_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.trades; latest public.trade_revisions;
begin
  select * into t from public.trades where id = p_trade_id for update;
  if t.origin is distinct from 'PLANNED' then
    raise exception 'NOT_A_DRAFT: Pre-trade AI tools only run on planned drafts';
  end if;
  if exists (select 1 from public.trade_lifecycle_events e where e.trade_id = t.id and e.event = 'DRAFT_DISCARDED') then
    raise exception 'DRAFT_DISCARDED: This draft was discarded';
  end if;
  if exists (select 1 from public.trade_plan_links l where l.trade_id = t.id) then
    raise exception 'PLAN_LOCKED: Plan already locked';
  end if;
  latest := private.latest_revision(t.id);
  if latest.proposal_id is distinct from p_proposal_id then
    raise exception 'NOT_LATEST_REVISION: Only the latest draft revision (revision %) can be analysed', latest.revision;
  end if;
end $$;

create or replace function public.start_bias_challenge(p_id uuid, p_user_id uuid, p_proposal_id uuid, p_facts jsonb, p_hash text,
  p_operation jsonb, p_contract jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare p public.setup_proposals; existing public.bias_challenges; v_trade uuid;
begin
  if coalesce(p_operation ->> 'id', '') not in ('CHALLENGE_BIAS','ANALYZE_SETUP') then raise exception 'Unknown proposal AI operation'; end if;
  select * into p from public.setup_proposals where id = p_proposal_id and user_id = p_user_id;
  if not found then raise exception 'Proposal not found'; end if;
  -- Same account lock used by deterministic plan locking, without changing its behavior.
  perform 1 from public.accounts where id = p.account_id and user_id = p_user_id for update;
  select * into existing from public.bias_challenges where id = p_id;
  if found then
    if existing.user_id <> p_user_id or existing.proposal_id <> p.id or existing.operation ->> 'id' is distinct from p_operation ->> 'id' then
      raise exception 'Challenge not found';
    end if;
    return false;
  end if;
  select r.trade_id into v_trade from public.trade_revisions r where r.proposal_id = p.id;
  if v_trade is not null then perform private.require_current_draft(v_trade, p.id); end if;
  if exists (select 1 from public.setup_locks where proposal_id = p.id) then raise exception 'Plan already locked'; end if;
  if exists (select 1 from public.bias_challenges c where c.proposal_id = p.id and c.deadline_at > clock_timestamp()
               and not exists (select 1 from public.bias_challenge_results r where r.challenge_id = c.id)) then
    raise exception 'Challenge already running';
  end if;
  insert into public.bias_challenges(id, user_id, account_id, proposal_id, facts, input_hash, operation, contract)
    values (p_id, p.user_id, p.account_id, p.id, p_facts, p_hash, p_operation, p_contract);
  return true;
end $$;

-- Each selected item is a non-removed legacy screenshot of the same proposal (0010) or, for a V2 draft revision, a
-- non-removed trade_evidence row of the same trade registered before the request, with the same sha256. Evidence of
-- a trade without a plan link is always pre-entry (there is no execution yet); the stored phase is asserted anyway.
create or replace function public.authorize_bias_challenge(p_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.bias_challenges; image jsonb; v_trade uuid;
begin
  select * into c from public.bias_challenges where id = p_id and user_id = p_user_id;
  if not found then raise exception 'Challenge not found'; end if;
  perform 1 from public.accounts where id = c.account_id and user_id = p_user_id for update;
  if c.deadline_at <= clock_timestamp() or exists (select 1 from public.bias_challenge_results where challenge_id = c.id) then
    raise exception 'Challenge already ended';
  end if;
  select r.trade_id into v_trade from public.trade_revisions r where r.proposal_id = c.proposal_id;
  if v_trade is not null then perform private.require_current_draft(v_trade, c.proposal_id); end if;
  if exists (select 1 from public.setup_locks where proposal_id = c.proposal_id) then raise exception 'Plan already locked'; end if;
  for image in select * from jsonb_array_elements(coalesce(c.facts -> 'selectedEvidence', '[]'::jsonb)) loop
    if not exists (select 1 from public.setup_screenshots s
                    where s.id = (image ->> 'id')::uuid and s.user_id = c.user_id and s.proposal_id = c.proposal_id
                      and s.sha256 = image ->> 'sha256'
                      and not exists (select 1 from public.setup_screenshot_removals r where r.screenshot_id = s.id))
       and not (v_trade is not null and exists (
                  select 1 from public.trade_evidence e
                   where e.id = (image ->> 'id')::uuid and e.user_id = c.user_id and e.trade_id = v_trade
                     and e.sha256 = image ->> 'sha256' and e.phase = 'PRE_ENTRY' and e.recorded_at < c.created_at
                     and not exists (select 1 from public.trade_evidence_removals x where x.evidence_id = e.id))) then
      raise exception '%', case when v_trade is null then 'Selected evidence changed' else 'EVIDENCE_CHANGED: Selected evidence changed' end;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §11.4 Timeline-aware trade review (REVIEW_TRADE_TIMELINE). History mirrors 0009 but is keyed by trades.id, so
-- planned, live-first and imported trades are all reviewable once closed.
-- ---------------------------------------------------------------------------------------------------------
create table public.trade_timeline_reviews (
  id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  operation jsonb not null check (operation ->> 'id' is not distinct from 'REVIEW_TRADE_TIMELINE'),
  contract jsonb not null check (jsonb_typeof(contract) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null default clock_timestamp() + interval '10 minutes',
  unique (user_id, account_id, id),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);
create index trade_timeline_reviews_trade on public.trade_timeline_reviews(trade_id, created_at desc, id desc);

create table public.trade_timeline_review_results (
  review_id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  status text not null check (status in ('COMPLETED','FAILED')),
  interpretation jsonb,
  error_code text,
  raw_output jsonb,
  reservation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  check ((status = 'COMPLETED' and interpretation is not null and jsonb_typeof(interpretation) = 'object' and error_code is null)
      or (status = 'FAILED' and interpretation is null and error_code is not null)),
  foreign key (user_id, account_id, review_id) references public.trade_timeline_reviews(user_id, account_id, id),
  foreign key (user_id, account_id, reservation_id) references public.ai_request_reservations(user_id, account_id, id)
);

-- §0.5: RLS with one owner read policy, no direct writes for any API role, immutability. The TRUNCATE guard for
-- every public table is installed by 0019_account_erasure.sql.
do $$
declare t text;
begin
  foreach t in array array['trade_timeline_reviews','trade_timeline_review_results'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy read_own on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create trigger immutable_record before update or delete on public.%I for each row execute function private.reject_mutation()', t);
  end loop;
end $$;

-- A close exists: a planned outcome through the plan link, or an unplanned close.
create function private.trade_closed(p_trade_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.trade_unplanned_closes c where c.trade_id = p_trade_id)
      or exists (select 1 from public.trade_plan_links l join public.trade_outcomes o on o.plan_id = l.plan_id
                  where l.trade_id = p_trade_id)
$$;

-- Facts evidence ({id, sha256, ...} items): at most four distinct items, each either a non-removed trade_evidence row
-- of this trade or a non-removed legacy screenshot of one of its proposals (revisions or the plan's locked
-- proposal), registered before p_before and still holding the recorded sha256.
create function private.check_timeline_review_evidence(p_trade public.trades, p_facts jsonb, p_before timestamptz) returns void
language plpgsql stable security definer set search_path = '' as $$
declare items jsonb := coalesce(p_facts -> 'evidence', '[]'::jsonb); image jsonb; v_id uuid;
begin
  if jsonb_typeof(items) <> 'array' then raise exception 'SCOPE_MISMATCH: Review evidence must be a list'; end if;
  if jsonb_array_length(items) > 4 then raise exception 'EVIDENCE_LIMIT: A trade review accepts at most four screenshots'; end if;
  if (select count(distinct x ->> 'id') from jsonb_array_elements(items) as x) <> jsonb_array_length(items) then
    raise exception 'SCOPE_MISMATCH: Review evidence is listed more than once';
  end if;
  for image in select * from jsonb_array_elements(items) loop
    v_id := private.uuid_input(image ->> 'id', 'evidence id');
    if not exists (select 1 from public.trade_evidence e
                    where e.id = v_id and e.user_id = p_trade.user_id and e.trade_id = p_trade.id
                      and e.sha256 = image ->> 'sha256' and e.recorded_at < p_before
                      and not exists (select 1 from public.trade_evidence_removals x where x.evidence_id = e.id))
       and not exists (select 1 from public.setup_screenshots s
                        where s.id = v_id and s.user_id = p_trade.user_id and s.sha256 = image ->> 'sha256'
                          and s.uploaded_at < p_before
                          and not exists (select 1 from public.setup_screenshot_removals x where x.screenshot_id = s.id)
                          and (exists (select 1 from public.trade_revisions r where r.trade_id = p_trade.id and r.proposal_id = s.proposal_id)
                            or exists (select 1 from public.trade_plan_links pl join public.setup_locks sl on sl.plan_id = pl.plan_id
                                        where pl.trade_id = p_trade.id and sl.proposal_id = s.proposal_id))) then
      raise exception 'EVIDENCE_CHANGED: Selected evidence changed';
    end if;
  end loop;
end $$;

-- Trusted server only. p_user_id is the verified session user and is re-checked against the trade. Returns false for
-- a replayed request id, which can never dispatch again.
create function public.start_trade_timeline_review(p_id uuid, p_user_id uuid, p_trade_id uuid, p_facts jsonb, p_hash text,
  p_operation jsonb, p_contract jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare t public.trades; existing public.trade_timeline_reviews; v_plan_status text;
begin
  if p_operation ->> 'id' is distinct from 'REVIEW_TRADE_TIMELINE' then
    raise exception 'UNKNOWN_OPERATION: Unknown trade review operation';
  end if;
  if p_id is null or p_user_id is null then raise exception 'INVALID_INPUT: A request id and user are required'; end if;
  select * into t from public.trades where id = p_trade_id and user_id = p_user_id for update;
  if not found then raise exception 'TRADE_NOT_FOUND: Trade not found'; end if;
  select * into existing from public.trade_timeline_reviews where id = p_id;
  if found then
    if existing.user_id <> p_user_id or existing.trade_id <> t.id then raise exception 'REVIEW_NOT_FOUND: Review not found'; end if;
    return false;
  end if;
  if not private.trade_closed(t.id) then raise exception 'NOT_CLOSED: Close the trade before review'; end if;
  v_plan_status := case when exists (select 1 from public.trade_plan_links l where l.trade_id = t.id)
                        then 'LOCKED_PLAN' else 'NO_PLAN_RECORDED' end;
  if p_facts ->> 'version' is distinct from 'REVIEW_TRADE_TIMELINE_FACTS_V1'
     or p_facts ->> 'tradeId' is distinct from t.id::text
     or p_facts ->> 'origin' is distinct from t.origin
     or p_facts ->> 'planStatus' is distinct from v_plan_status then
    raise exception 'SCOPE_MISMATCH: Review facts do not describe this trade';
  end if;
  perform private.check_timeline_review_evidence(t, p_facts, clock_timestamp());
  if exists (select 1 from public.trade_timeline_reviews r where r.trade_id = t.id and r.deadline_at > clock_timestamp()
               and not exists (select 1 from public.trade_timeline_review_results x where x.review_id = r.id)) then
    raise exception 'REVIEW_IN_PROGRESS: Review already running';
  end if;
  insert into public.trade_timeline_reviews(id, user_id, account_id, trade_id, facts, input_hash, operation, contract)
    values (p_id, t.user_id, t.account_id, t.id, p_facts, p_hash, p_operation, p_contract);
  return true;
end $$;

-- Called before reservation, dispatch and generation: the request is still open, the trade still closed and every
-- selected screenshot still belongs to it unchanged.
create function public.authorize_trade_timeline_review(p_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.trade_timeline_reviews; t public.trades;
begin
  select * into r from public.trade_timeline_reviews where id = p_id and user_id = p_user_id;
  if not found then raise exception 'REVIEW_NOT_FOUND: Review not found'; end if;
  select * into t from public.trades where id = r.trade_id and user_id = p_user_id for update;
  if not found then raise exception 'TRADE_NOT_FOUND: Trade not found'; end if;
  if r.deadline_at <= clock_timestamp() or exists (select 1 from public.trade_timeline_review_results x where x.review_id = r.id) then
    raise exception 'REVIEW_ENDED: Review already ended';
  end if;
  if not private.trade_closed(t.id) then raise exception 'NOT_CLOSED: Close the trade before review'; end if;
  perform private.check_timeline_review_evidence(t, r.facts, r.created_at);
end $$;

-- Append-only result. COMPLETED requires SETTLED usage for this exact request's reservation.
create function public.finish_trade_timeline_review(p_id uuid, p_user_id uuid, p_status text, p_interpretation jsonb, p_error text,
  p_raw jsonb, p_reservation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.trade_timeline_reviews;
begin
  if p_status is null or p_status not in ('COMPLETED','FAILED') then
    raise exception 'INVALID_INPUT: status must be COMPLETED or FAILED';
  end if;
  select * into r from public.trade_timeline_reviews where id = p_id and user_id = p_user_id for update;
  if not found then raise exception 'REVIEW_NOT_FOUND: Review not found'; end if;
  if exists (select 1 from public.trade_timeline_review_results x where x.review_id = r.id) then
    raise exception 'REVIEW_ALREADY_FINISHED: This review already has a result';
  end if;
  if p_reservation_id is not null and not exists (
       select 1 from public.ai_request_reservations a
        where a.id = p_reservation_id and a.user_id = r.user_id and a.account_id = r.account_id
          and a.operation_id = r.id and a.operation = 'REVIEW_TRADE_TIMELINE') then
    raise exception 'RESERVATION_MISMATCH: Reservation mismatch';
  end if;
  if p_status = 'COMPLETED' and not exists (
       select 1 from public.ai_usage_records u
        where u.reservation_id = p_reservation_id and u.user_id = r.user_id and u.disposition = 'SETTLED') then
    raise exception 'USAGE_NOT_SETTLED: Usage must be reconciled before completion';
  end if;
  insert into public.trade_timeline_review_results(review_id, user_id, account_id, status, interpretation, error_code, raw_output, reservation_id)
    values (r.id, r.user_id, r.account_id, p_status, p_interpretation, p_error, p_raw, p_reservation_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Read models. RLS of every base table applies to both views (security_invoker).
-- ---------------------------------------------------------------------------------------------------------
-- One row per trade: completed pre-trade analyses (any revision), completed V1 reviews (through the plan link),
-- completed timeline reviews and the latest AI completion.
create view public.trade_ai_activity with (security_invoker = true) as
select
  t.id as trade_id,
  t.account_id,
  pre_trade.completed as pre_trade_analysis_count,
  trade_review.completed as trade_review_count,
  timeline_review.completed as timeline_review_count,
  greatest(pre_trade.last_completed_at, trade_review.last_completed_at, timeline_review.last_completed_at) as last_completed_at
from public.trades t
cross join lateral (
  select count(*)::int as completed, max(x.created_at) as last_completed_at
    from public.trade_revisions r
    join public.bias_challenges c on c.proposal_id = r.proposal_id
    join public.bias_challenge_results x on x.challenge_id = c.id
   where r.trade_id = t.id and x.status = 'COMPLETED'
) pre_trade
cross join lateral (
  select count(*)::int as completed, max(x.created_at) as last_completed_at
    from public.trade_plan_links l
    join public.trade_ai_reviews a on a.plan_id = l.plan_id
    join public.trade_ai_review_results x on x.review_id = a.id
   where l.trade_id = t.id and x.status = 'COMPLETED'
) trade_review
cross join lateral (
  select count(*)::int as completed, max(x.created_at) as last_completed_at
    from public.trade_timeline_reviews a
    join public.trade_timeline_review_results x on x.review_id = a.id
   where a.trade_id = t.id and x.status = 'COMPLETED'
) timeline_review;
revoke all on public.trade_ai_activity from public, anon, authenticated, service_role;
grant select on public.trade_ai_activity to authenticated;

-- §3.12 trade_ledger.ai_review_count counts the trade's completed reviews of both kinds: V1 REVIEW_TRADE through the
-- plan link (0015) plus REVIEW_TRADE_TIMELINE. The view is rebuilt from its stored definition with only that column
-- expression replaced, so every other column keeps exactly what the earlier migrations define; the migration fails if
-- the 0015 expression is not found exactly once. create or replace requires the same columns and keeps grants and
-- dependent objects.
do $$
declare
  v_search_path constant text := pg_catalog.current_setting('search_path');
  v_column constant text := 'ai_reviews.review_count AS ai_review_count';
  v_definition text;
begin
  -- An empty search_path prints every name schema-qualified, as pg_dump does.
  perform pg_catalog.set_config('search_path', '', true);
  v_definition := pg_catalog.rtrim(pg_catalog.pg_get_viewdef('public.trade_ledger'::pg_catalog.regclass), ';');
  if pg_catalog.array_length(pg_catalog.string_to_array(v_definition, v_column), 1) is distinct from 2 then
    raise exception 'LEDGER_DEFINITION_CHANGED: trade_ledger.ai_review_count is not the 0015 expression';
  end if;
  execute 'create or replace view public.trade_ledger with (security_invoker = true) as '
    || pg_catalog.replace(v_definition, v_column,
         '(ai_reviews.review_count + (select count(*)::integer from public.trade_timeline_reviews timeline_review'
         || ' join public.trade_timeline_review_results timeline_result on timeline_result.review_id = timeline_review.id'
         || ' where timeline_review.trade_id = t.id and timeline_result.status = ''COMPLETED'')) as ai_review_count');
  perform pg_catalog.set_config('search_path', v_search_path, true);
end $$;
revoke all on public.trade_ledger from public, anon, authenticated, service_role;
grant select on public.trade_ledger to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Function privileges: explicit revoke per signature, then the exact grant (start_/authorize_bias_challenge keep
-- the 0010 grants through create or replace; they are restated here).
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  private.require_current_draft(uuid, uuid), private.trade_closed(uuid),
  private.check_timeline_review_evidence(public.trades, jsonb, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function
  public.start_bias_challenge(uuid, uuid, uuid, jsonb, text, jsonb, jsonb), public.authorize_bias_challenge(uuid, uuid),
  public.start_trade_timeline_review(uuid, uuid, uuid, jsonb, text, jsonb, jsonb), public.authorize_trade_timeline_review(uuid, uuid),
  public.finish_trade_timeline_review(uuid, uuid, text, jsonb, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function
  public.start_bias_challenge(uuid, uuid, uuid, jsonb, text, jsonb, jsonb), public.authorize_bias_challenge(uuid, uuid),
  public.start_trade_timeline_review(uuid, uuid, uuid, jsonb, text, jsonb, jsonb), public.authorize_trade_timeline_review(uuid, uuid),
  public.finish_trade_timeline_review(uuid, uuid, text, jsonb, text, jsonb, uuid)
  to service_role;

notify pgrst, 'reload schema';
