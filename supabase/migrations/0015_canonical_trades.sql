-- Trading OS V2: canonical trades (docs/V2_ARCHITECTURE.md §0.5, §2.2, §3, §5.2).
-- Additive only. New tables are append-only; the V1 backfill inserts rows and never updates or deletes.
-- Planned-trade RPCs delegate every risk, lock, fill, outcome and disposition decision to the V1 functions
-- (save_setup_proposal, check_setup_risk, open/close_journal_trade, set_journal_disposition). Their V1 logic is
-- unchanged; check_setup_risk only gains the trade-model guard and plan link of §10.4.
-- Errors raised here start with a stable code prefix ('DRAFT_CHANGED: ...'); known V1 messages are re-raised
-- with a prefix as well (private.v1_error_message), keeping the original text after it.

-- ---------------------------------------------------------------------------------------------------------
-- §3.1 Strategy template: byte-identical ICT V1.0 content taken from create_demo_account (0002).
-- ---------------------------------------------------------------------------------------------------------
create table private.strategy_templates (
  version text primary key,
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  written_rules text not null check (length(written_rules) > 0)
);
revoke all on private.strategy_templates from public, anon, authenticated, service_role;
create trigger immutable_record before update or delete on private.strategy_templates
  for each row execute function private.reject_mutation();

-- The rules literal follows 'ICT V1.0',' and ends at '::jsonb,'; the written rules follow and end at the last
-- '); before the risk-plan insert. Reading pg_proc.prosrc keeps whatever line endings this database was built
-- with, so V2 accounts receive exactly the bytes every existing account received.
do $$
declare
  q constant text := chr(39);
  rules_open constant text := q || 'ICT V1.0' || q || ',' || q;
  rules_close constant text := q || '::jsonb,' || q;
  src text;
  open_at int;
  rules_from int;
  rules_len int;
  written_from int;
  risk_insert_at int;
  head text;
  written_quote_at int;
  v_rules jsonb;
  v_written text;
begin
  select p.prosrc into src from pg_catalog.pg_proc p
   where p.oid = 'public.create_demo_account(text,text,text)'::pg_catalog.regprocedure;
  open_at := strpos(src, rules_open);
  rules_from := open_at + length(rules_open);
  rules_len := strpos(substr(src, rules_from), rules_close) - 1;
  written_from := rules_from + rules_len + length(rules_close);
  risk_insert_at := strpos(src, 'insert into public.risk_plan_versions');
  head := left(src, risk_insert_at - 1);
  written_quote_at := length(head) - strpos(reverse(head), ';)' || q) - 1;
  if open_at = 0 or rules_len < 2 or risk_insert_at <= written_from or written_quote_at <= written_from then
    raise exception 'STRATEGY_TEMPLATE_UNAVAILABLE: create_demo_account does not contain the ICT V1.0 seed';
  end if;
  v_rules := replace(substr(src, rules_from, rules_len), q || q, q)::jsonb;
  v_written := replace(substr(src, written_from, written_quote_at - written_from), q || q, q);
  if v_rules ->> 'version' is distinct from 'ICT V1.0' then
    raise exception 'STRATEGY_TEMPLATE_UNAVAILABLE: extracted rules are not ICT V1.0';
  end if;
  insert into private.strategy_templates(version, rules, written_rules) values ('ICT V1.0', v_rules, v_written);
end $$;

create function private.seed_ict_strategy(p_user uuid, p_account uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.strategy_versions(user_id, account_id, version, rules, written_rules)
  select p_user, p_account, t.version, t.rules, t.written_rules
    from private.strategy_templates t where t.version = 'ICT V1.0'
  returning id into v_id;
  if v_id is null then raise exception 'STRATEGY_TEMPLATE_UNAVAILABLE: the ICT V1.0 template is missing'; end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.2 Trading accounts: currencies, profiles. accounts.mode stays 'DEMO' (legacy column; V2 type is in the
-- profile and is never derived from mode).
-- ---------------------------------------------------------------------------------------------------------
alter table public.accounts drop constraint accounts_currency_check;
alter table public.accounts add constraint accounts_currency_check
  check (currency in ('USD','EUR','GBP','CHF','JPY','AUD','CAD','NZD','SGD','HKD','SEK','NOK','DKK','PLN','CZK','HUF','ZAR','MXN'));
alter table public.instrument_versions drop constraint instrument_versions_currency_check;
alter table public.instrument_versions add constraint instrument_versions_currency_check
  check (currency in ('USD','EUR','GBP','CHF','JPY','AUD','CAD','NZD','SGD','HKD','SEK','NOK','DKK','PLN','CZK','HUF','ZAR','MXN'));

create function private.supported_currencies() returns text[]
language sql immutable set search_path = '' as $$
  select array['USD','EUR','GBP','CHF','JPY','AUD','CAD','NZD','SGD','HKD','SEK','NOK','DKK','PLN','CZK','HUF','ZAR','MXN']
$$;

-- Append-only revisions; the latest id wins.
create table public.account_profiles (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  account_id uuid not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  broker text check (broker is null or length(btrim(broker)) between 1 and 100),
  platform text not null check (platform in ('MANUAL','CTRADER','MT5','MT4','TRADINGVIEW','OTHER')),
  account_type text not null check (account_type in ('DEMO','EVALUATION','FUNDED','PERSONAL','OTHER')),
  starting_balance numeric(20,2) check (starting_balance > 0 and starting_balance < 1000000000000),
  status text not null check (status in ('ACTIVE','ARCHIVED')),
  source text not null default 'USER' check (source in ('USER','MIGRATION')),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id) references public.accounts(user_id, id)
);
create index account_profiles_latest on public.account_profiles(account_id, id desc);

-- ---------------------------------------------------------------------------------------------------------
-- §3.10 Risk policy v2 column. Legacy versions keep null, meaning "default equals maximum" (V1 behaviour).
-- ---------------------------------------------------------------------------------------------------------
alter table public.risk_plan_versions add column default_risk_percent numeric(11,8);
alter table public.risk_plan_versions add constraint risk_plan_versions_default_risk_percent_check
  check (default_risk_percent is null or (default_risk_percent > 0 and default_risk_percent <= max_risk_percent));

-- ---------------------------------------------------------------------------------------------------------
-- §3.3 Trades, revisions, plan links, lifecycle events.
-- ---------------------------------------------------------------------------------------------------------
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  origin text not null check (origin in ('PLANNED','LIVE_FIRST','IMPORTED')),
  created_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  duplicated_from uuid,
  migrated_from text check (migrated_from in ('V1_PLAN','V1_PROPOSAL')),
  unique (user_id, account_id, id),
  unique (user_id, request_key),
  foreign key (user_id, account_id) references public.accounts(user_id, id),
  foreign key (user_id, account_id, duplicated_from) references public.trades(user_id, account_id, id),
  check (migrated_from is null or origin = 'PLANNED'),
  check (duplicated_from is null or (origin = 'PLANNED' and duplicated_from <> id))
);
create index trades_account_created on public.trades(account_id, created_at desc);

create table public.trade_revisions (
  proposal_id uuid primary key,
  trade_id uuid not null,
  revision int not null check (revision >= 1),
  user_id uuid not null,
  account_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (trade_id, revision),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, proposal_id) references public.setup_proposals(user_id, account_id, id)
);

create table public.trade_plan_links (
  trade_id uuid primary key,
  plan_id uuid not null unique,
  user_id uuid not null,
  account_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, plan_id) references public.trade_plans(user_id, account_id, id)
);

create table public.trade_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  event text not null check (event in ('DRAFT_DISCARDED','REVIEW_COMPLETED','REVIEW_REOPENED')),
  reason text check (reason is null or length(btrim(reason)) between 1 and 2000),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  unique (user_id, request_key),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);
create index trade_lifecycle_events_latest on public.trade_lifecycle_events(trade_id, recorded_at desc);

-- ---------------------------------------------------------------------------------------------------------
-- §3.5 Live-first and imported positions. Effective value of a fact = first non-null in (recorded_at, id).
-- ---------------------------------------------------------------------------------------------------------
create table public.trade_position_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  instrument_version_id uuid,
  symbol text check (symbol is null or symbol ~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$'),
  direction text check (direction in ('LONG','SHORT')),
  entry_model text check (entry_model in ('OB_FIRST_TOUCH','OTE','OTHER')),
  entry_price numeric check (entry_price > 0),
  entered_at timestamptz,
  quantity numeric check (quantity > 0),
  initial_stop numeric check (initial_stop > 0),
  risk_amount numeric(20,2) check (risk_amount > 0),
  source text not null check (source in ('USER','IMPORT')),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  unique (user_id, request_key),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, instrument_version_id) references public.instrument_versions(user_id, account_id, id),
  constraint trade_position_facts_finite check (
    entry_price not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and quantity not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and initial_stop not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and risk_amount <> 'NaN'::numeric
    and (entered_at is null or isfinite(entered_at))
    and isfinite(recorded_at))
);
create index trade_position_facts_order on public.trade_position_facts(trade_id, recorded_at, id);

create table public.trade_unplanned_closes (
  trade_id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  exit_price numeric check (exit_price > 0),
  exited_at timestamptz not null,
  fees numeric(20,2) not null check (fees >= 0),
  gross_pnl numeric,
  net_pnl numeric not null,
  pnl_source text not null check (pnl_source in ('CALCULATED','USER_REPORTED','IMPORTED')),
  risk_basis numeric check (risk_basis > 0),
  risk_basis_source text check (risk_basis_source in ('USER_REPORTED','DERIVED')),
  realized_r numeric,
  outcome text not null check (outcome in ('WIN','LOSS','BREAKEVEN')),
  calculation_version text not null default 'UNPLANNED_CLOSE_V1' check (calculation_version = 'UNPLANNED_CLOSE_V1'),
  recorded_at timestamptz not null default clock_timestamp(),
  check ((outcome = 'WIN' and net_pnl > 0) or (outcome = 'LOSS' and net_pnl < 0) or (outcome = 'BREAKEVEN' and net_pnl = 0)),
  check ((realized_r is null) = (risk_basis is null)),
  check ((risk_basis is null) = (risk_basis_source is null)),
  check (gross_pnl is null or net_pnl = gross_pnl - fees),
  constraint trade_unplanned_closes_finite check (
    exit_price not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and fees <> 'NaN'::numeric
    and gross_pnl not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and net_pnl not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and risk_basis not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and realized_r not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    and isfinite(exited_at) and isfinite(recorded_at)),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);

-- ---------------------------------------------------------------------------------------------------------
-- §3.6 Live trade journal. Partial closes are journal records, never accounting events.
-- ---------------------------------------------------------------------------------------------------------
create table public.trade_journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  kind text not null check (kind in ('NOTE','DECISION','STOP_CHANGE','TARGET_CHANGE','PARTIAL_CLOSE','LESSON')),
  body text check (body is null or length(btrim(body)) between 1 and 5000),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  phase text not null check (phase in ('PRE_ENTRY','LIVE','POST_TRADE')),
  state_at_creation text not null,
  source text not null default 'USER' check (source in ('USER','IMPORT')),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  unique (user_id, request_key),
  check (body is not null or details <> '{}'::jsonb),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);
create index trade_journal_entries_order on public.trade_journal_entries(trade_id, recorded_at, id);

-- ---------------------------------------------------------------------------------------------------------
-- §3.7 Trade evidence (V2 screenshots). Registration is service-only; relabel/remove are appended.
-- ---------------------------------------------------------------------------------------------------------
create table public.trade_evidence (
  id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  storage_path text not null unique check (storage_path = user_id::text || '/' || trade_id::text || '/' || id::text),
  label text not null check (label in ('HTF','CONTEXT','PRE_ENTRY','ENTRY','MANAGEMENT','EXIT','OTHER')),
  timeframe text check (timeframe in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER')),
  caption text check (caption is null or length(btrim(caption)) between 1 and 200),
  original_filename text not null check (length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size integer not null check (byte_size between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  phase text not null check (phase in ('PRE_ENTRY','LIVE','POST_TRADE')),
  state_at_creation text not null,
  capture_method text not null check (capture_method in ('PASTE','DROP','FILE','CAMERA','DUPLICATE','IMPORT')),
  copied_from uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  check (width::bigint * height <= 40000000),
  unique (user_id, account_id, trade_id, id),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);
create index trade_evidence_order on public.trade_evidence(trade_id, recorded_at, id);

create table public.trade_evidence_removals (
  evidence_id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id, evidence_id) references public.trade_evidence(user_id, account_id, trade_id, id)
);

create table public.trade_evidence_labels (
  id bigint generated always as identity primary key,
  evidence_id uuid not null,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  label text not null check (label in ('HTF','CONTEXT','PRE_ENTRY','ENTRY','MANAGEMENT','EXIT','OTHER')),
  timeframe text check (timeframe in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER')),
  caption text check (caption is null or length(btrim(caption)) between 1 and 200),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id, evidence_id) references public.trade_evidence(user_id, account_id, trade_id, id)
);
create index trade_evidence_labels_latest on public.trade_evidence_labels(evidence_id, id desc);

-- ---------------------------------------------------------------------------------------------------------
-- §3.8 Tags. At most 12 unique tags, each ^[a-z0-9][a-z0-9 _-]{0,31}$.
-- ---------------------------------------------------------------------------------------------------------
create function private.valid_tags(p_tags text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_tags is not null
     and coalesce(array_ndims(p_tags), 1) = 1
     and cardinality(p_tags) <= 12
     and not exists (select 1 from unnest(p_tags) as x(tag) where x.tag is null or x.tag !~ '^[a-z0-9][a-z0-9 _-]{0,31}$')
     and cardinality(p_tags) = (select count(distinct x.tag) from unnest(p_tags) as x(tag))
$$;

create table public.trade_tag_sets (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  account_id uuid not null,
  trade_id uuid not null,
  setup_grade text check (setup_grade in ('A+','A','B','C','INVALID')),
  liquidity_context text check (liquidity_context in ('ARL_HIGH','ARL_LOW','PDH','PDL','PWH','PWL','KZ_HIGH','KZ_LOW','EQUAL_HIGHS','EQUAL_LOWS','OTHER')),
  mss_timeframe text check (mss_timeframe in ('M15','M5','M3')),
  tags text[] not null default '{}' check (private.valid_tags(tags)),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id)
);
create index trade_tag_sets_latest on public.trade_tag_sets(trade_id, id desc);

-- ---------------------------------------------------------------------------------------------------------
-- §3.9 External losses (losses not recorded as Trading OS trades).
-- ---------------------------------------------------------------------------------------------------------
create table public.external_loss_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  trading_day date not null,
  amount numeric(20,2) not null check (amount > 0 and amount < 1000000000000),
  note text check (note is null or length(btrim(note)) between 1 and 500),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  unique (user_id, request_key),
  unique (user_id, account_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id)
);
create index external_loss_entries_day on public.external_loss_entries(account_id, trading_day);

create table public.external_loss_removals (
  entry_id uuid primary key,
  user_id uuid not null,
  account_id uuid not null,
  reason text check (reason is null or length(btrim(reason)) between 1 and 500),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, entry_id) references public.external_loss_entries(user_id, account_id, id)
);

-- ---------------------------------------------------------------------------------------------------------
-- §0.5 Every new table: RLS, a single owner read policy, no direct writes for any API role, immutability.
-- The TRUNCATE guard for every public table is installed by 0019_account_erasure.sql.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['account_profiles','trades','trade_revisions','trade_plan_links','trade_lifecycle_events',
    'trade_position_facts','trade_unplanned_closes','trade_journal_entries','trade_evidence','trade_evidence_removals',
    'trade_evidence_labels','trade_tag_sets','external_loss_entries','external_loss_removals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy read_own on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create trigger immutable_record before update or delete on public.%I for each row execute function private.reject_mutation()', t);
  end loop;
end $$;
revoke all on sequence public.account_profiles_id_seq, public.trade_evidence_labels_id_seq, public.trade_tag_sets_id_seq
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Backfill (insert-only, deterministic mapping). Every account gets one MIGRATION profile; every V1 plan and
-- every unlocked V1 proposal becomes exactly one PLANNED trade. Backfilled trades have no request key.
-- ---------------------------------------------------------------------------------------------------------
insert into public.account_profiles(user_id, account_id, display_name, platform, account_type, starting_balance, status, source)
select a.user_id, a.id, a.name, 'MANUAL', 'DEMO', first_observation.balance, 'ACTIVE', 'MIGRATION'
  from public.accounts a
  left join lateral (
    select o.balance from public.account_observations o
     where o.account_id = a.id order by o.recorded_at, o.id limit 1
  ) first_observation on true
 order by a.created_at, a.id;

-- A plan has at most one linked proposal (setup_locks.plan_id is unique), which becomes revision 1.
with plan_source as (
  select gen_random_uuid() as trade_id, p.user_id, p.account_id, p.id as plan_id, p.locked_at,
         s.id as proposal_id, s.created_at as proposal_created_at
    from public.trade_plans p
    left join public.setup_locks l on l.plan_id = p.id
    left join public.setup_proposals s on s.id = l.proposal_id
), new_trades as (
  insert into public.trades(id, user_id, account_id, origin, created_at, migrated_from)
  select trade_id, user_id, account_id, 'PLANNED', least(locked_at, proposal_created_at), 'V1_PLAN'
    from plan_source order by least(locked_at, proposal_created_at), plan_id
), new_links as (
  insert into public.trade_plan_links(trade_id, plan_id, user_id, account_id, created_at)
  select trade_id, plan_id, user_id, account_id, locked_at from plan_source
)
insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id, created_at)
select proposal_id, trade_id, 1, user_id, account_id, proposal_created_at
  from plan_source where proposal_id is not null;

with proposal_source as (
  select gen_random_uuid() as trade_id, s.id as proposal_id, s.user_id, s.account_id, s.created_at
    from public.setup_proposals s
   where not exists (select 1 from public.setup_locks l where l.proposal_id = s.id)
), new_trades as (
  insert into public.trades(id, user_id, account_id, origin, created_at, migrated_from)
  select trade_id, user_id, account_id, 'PLANNED', created_at, 'V1_PROPOSAL'
    from proposal_source order by created_at, proposal_id
)
insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id, created_at)
select proposal_id, trade_id, 1, user_id, account_id, created_at from proposal_source;

-- ---------------------------------------------------------------------------------------------------------
-- §3.7 Private bucket for V2 evidence. Policies mirror 0005 but are keyed to public.trade_evidence; the legacy
-- 'setup-screenshots' bucket and its policies are untouched.
-- ---------------------------------------------------------------------------------------------------------
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('trade-evidence', 'trade-evidence', false, 4194304, array['image/png','image/jpeg','image/webp']);
create policy trade_evidence_owner_read on storage.objects for select to authenticated
using (bucket_id = 'trade-evidence' and exists (
  select 1 from public.trade_evidence e where e.storage_path = name and e.user_id = (select auth.uid())
));
create policy trade_evidence_read_guard on storage.objects as restrictive for select to anon, authenticated
using (bucket_id <> 'trade-evidence' or exists (
  select 1 from public.trade_evidence e where e.storage_path = name and e.user_id = (select auth.uid())
));
create policy trade_evidence_insert_guard on storage.objects as restrictive for insert to anon, authenticated
with check (bucket_id <> 'trade-evidence');
create policy trade_evidence_update_guard on storage.objects as restrictive for update to anon, authenticated
using (bucket_id <> 'trade-evidence') with check (bucket_id <> 'trade-evidence');
create policy trade_evidence_delete_guard on storage.objects as restrictive for delete to anon, authenticated
using (bucket_id <> 'trade-evidence');

-- ---------------------------------------------------------------------------------------------------------
-- §3.12 Ledger: one row per trade, RLS of every base table applies (security_invoker). Numeric values are
-- canonical text (trim_scale). Planned trades read the locked plan when present, else the latest revision;
-- live-first/imported trades read effective position facts and never get planned_* values.
-- §2.2 lifecycle is derived here; private.trade_lifecycle() reads this view so the RPCs cannot diverge.
-- ---------------------------------------------------------------------------------------------------------
create view public.trade_ledger with (security_invoker = true) as
select
  t.id,
  t.account_id,
  t.origin,
  t.created_at,
  t.duplicated_from,
  t.migrated_from,
  a.currency,
  revisions.revision_count,
  latest.revision as latest_revision,
  latest.proposal_id as latest_proposal_id,
  latest.created_at as latest_revision_at,
  checks.decision as latest_check_decision,
  checks.recorded_at as latest_check_at,
  checks.id as latest_check_evaluation_id,
  link.plan_id,
  plan.locked_at,
  plan.trading_day as plan_trading_day,
  strategy.id as strategy_version_id,
  strategy.version as strategy_version,
  risk_plan.id as risk_plan_version_id,
  risk_plan.version as risk_plan_version,
  case when t.origin = 'PLANNED' then instrument.symbol else facts.symbol end as symbol,
  instrument.id as instrument_version_id,
  case when t.origin = 'PLANNED' then src.proposal ->> 'direction' else facts.direction end as direction,
  case when t.origin = 'PLANNED' then src.proposal ->> 'model' else facts.entry_model end as entry_model,
  trim_scale(planned.entry)::text as planned_entry,
  trim_scale(planned.stop)::text as planned_stop,
  trim_scale(planned.target)::text as planned_target,
  trim_scale(planned.risk_percent)::text as requested_risk_percent,
  case when planned.entry is not null and planned.stop is not null and planned.target is not null
        and ((src.proposal ->> 'direction' = 'LONG' and planned.stop < planned.entry and planned.target > planned.entry)
          or (src.proposal ->> 'direction' = 'SHORT' and planned.stop > planned.entry and planned.target < planned.entry))
       then trim_scale(div(abs(planned.target - planned.entry) * 100000000, abs(planned.entry - planned.stop)) * 0.00000001)::text
  end as planned_rr,
  trim_scale(planned.quantity)::text as planned_quantity,
  trim_scale(planned.nominal_risk)::text as planned_risk,
  trim_scale(entry.price)::text as entry_price,
  entry.entered_at,
  entry.entered_at is not null as entry_time_known,
  entry.recorded_at as entry_recorded_at,
  trim_scale(entry.quantity)::text as quantity,
  trim_scale(entry.initial_stop)::text as initial_stop,
  trim_scale(entry.initial_risk)::text as initial_risk,
  trim_scale(entry.actual_risk)::text as actual_initial_risk,
  case when execution.id is not null and planned.quantity is not null then execution.quantity > planned.quantity end as oversize,
  trim_scale(coalesce(outcome.exit_price, unplanned_close.exit_price))::text as exit_price,
  coalesce(outcome.exited_at, unplanned_close.exited_at) as exited_at,
  coalesce(outcome.recorded_at, unplanned_close.recorded_at) as close_recorded_at,
  trim_scale(coalesce(outcome.fees, unplanned_close.fees))::text as fees,
  trim_scale(coalesce(outcome.gross_pnl, unplanned_close.gross_pnl))::text as gross_pnl,
  trim_scale(coalesce(outcome.net_pnl, unplanned_close.net_pnl))::text as net_pnl,
  trim_scale(coalesce(outcome.realized_r, unplanned_close.realized_r))::text as realized_r,
  coalesce(outcome.outcome, unplanned_close.outcome) as outcome,
  coalesce(outcome.calculation_version, unplanned_close.calculation_version) as calculation_version,
  case when outcome.id is not null then 'CALCULATED' else unplanned_close.pnl_source end as pnl_source,
  disposition.status as disposition,
  disposition.reason as disposition_reason,
  decision.decision as legacy_decision,
  events.discarded_at,
  state.lifecycle,
  case when state.lifecycle = 'DRAFT' then coalesce(checks.decision, 'UNCHECKED') end as draft_check,
  case when events.review_state = 'REVIEW_COMPLETED' then events.last_completed_at end as review_completed_at,
  case when tag_set.tags is not null then tag_set.setup_grade else legacy_tags.setup_grade end as setup_grade,
  case when tag_set.tags is not null then tag_set.liquidity_context else legacy_tags.liquidity_context end as liquidity_context,
  case when tag_set.tags is not null then tag_set.mss_timeframe else legacy_tags.mss_timeframe end as mss_timeframe,
  coalesce(tag_set.tags, '{}'::text[]) as tags,
  case when tag_set.tags is not null then 'V2' when legacy_tags.id is not null then 'V1' end as tag_source,
  evidence.active_count + legacy_evidence.active_count as evidence_count,
  coalesce(evidence.first_id, legacy_evidence.first_id) as cover_evidence_id,
  case when evidence.first_id is not null then 'V2' when legacy_evidence.first_id is not null then 'LEGACY' end as cover_evidence_kind,
  journal.entry_count as journal_count,
  ai_reviews.review_count as ai_review_count
from public.trades t
join public.accounts a on a.id = t.account_id
cross join lateral (
  select count(*)::int as revision_count from public.trade_revisions r where r.trade_id = t.id
) revisions
left join lateral (
  select r.proposal_id, r.revision, r.created_at from public.trade_revisions r
   where r.trade_id = t.id order by r.revision desc limit 1
) latest on true
left join public.setup_proposals latest_proposal on latest_proposal.id = latest.proposal_id
left join lateral (
  select e.id, e.recorded_at, e.risk_plan_version_id, e.result,
         coalesce(e.result ->> 'decision',
                  case e.result ->> 'status' when 'RISK_APPROVED' then 'APPROVED' when 'TRADE_BLOCKED' then 'BLOCKED' end) as decision
    from public.setup_risk_checks c
    join public.risk_evaluations e on e.id = c.risk_evaluation_id
   where c.proposal_id = latest.proposal_id
   order by c.id desc limit 1
) checks on true
left join public.trade_plan_links link on link.trade_id = t.id
left join public.trade_plans plan on plan.id = link.plan_id
left join public.trade_executions execution on execution.plan_id = plan.id
left join public.trade_outcomes outcome on outcome.plan_id = plan.id
left join public.trade_dispositions disposition on disposition.plan_id = plan.id
left join public.trade_unplanned_closes unplanned_close on unplanned_close.trade_id = t.id
cross join lateral (
  select min(f.recorded_at) as first_recorded_at,
         (array_agg(f.instrument_version_id order by f.recorded_at, f.id) filter (where f.instrument_version_id is not null))[1] as instrument_version_id,
         (array_agg(f.symbol order by f.recorded_at, f.id) filter (where f.symbol is not null))[1] as symbol,
         (array_agg(f.direction order by f.recorded_at, f.id) filter (where f.direction is not null))[1] as direction,
         (array_agg(f.entry_model order by f.recorded_at, f.id) filter (where f.entry_model is not null))[1] as entry_model,
         (array_agg(f.entry_price order by f.recorded_at, f.id) filter (where f.entry_price is not null))[1] as entry_price,
         (array_agg(f.entered_at order by f.recorded_at, f.id) filter (where f.entered_at is not null))[1] as entered_at,
         (array_agg(f.quantity order by f.recorded_at, f.id) filter (where f.quantity is not null))[1] as quantity,
         (array_agg(f.initial_stop order by f.recorded_at, f.id) filter (where f.initial_stop is not null))[1] as initial_stop,
         (array_agg(f.risk_amount order by f.recorded_at, f.id) filter (where f.risk_amount is not null))[1] as risk_amount
    from public.trade_position_facts f where f.trade_id = t.id
) facts
cross join lateral (
  select case when t.origin = 'PLANNED' then coalesce(plan.proposal, latest_proposal.proposal) end as proposal,
         case when t.origin = 'PLANNED' then coalesce(plan.risk_result, checks.result) end as report
) src
cross join lateral (
  select case when src.proposal ->> 'entry' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then (src.proposal ->> 'entry')::numeric end as entry,
         case when src.proposal ->> 'stop' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then (src.proposal ->> 'stop')::numeric end as stop,
         case when src.proposal ->> 'target' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then (src.proposal ->> 'target')::numeric end as target,
         case when src.proposal ->> 'riskPercent' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then (src.proposal ->> 'riskPercent')::numeric end as risk_percent,
         case when src.report #>> '{calculations,quantity}' ~ '^[0-9]+(\.[0-9]+)?$' then (src.report #>> '{calculations,quantity}')::numeric end as quantity,
         case when plan.id is not null then plan.nominal_risk
              when src.report #>> '{calculations,nominalRisk}' ~ '^[0-9]+(\.[0-9]+)?$' then (src.report #>> '{calculations,nominalRisk}')::numeric
         end as nominal_risk
) planned
left join public.instrument_versions instrument on instrument.id =
  case when t.origin = 'PLANNED' then coalesce(plan.instrument_version_id, latest_proposal.instrument_version_id) else facts.instrument_version_id end
left join public.strategy_versions strategy on strategy.id =
  case when t.origin = 'PLANNED' then coalesce(plan.strategy_version_id, latest_proposal.strategy_version_id) end
left join public.risk_plan_versions risk_plan on risk_plan.id =
  case when t.origin = 'PLANNED' then coalesce(plan.risk_plan_version_id, checks.risk_plan_version_id) end
cross join lateral (
  select case when t.origin = 'PLANNED' then execution.entry_price else facts.entry_price end as price,
         case when t.origin = 'PLANNED' then execution.entered_at else facts.entered_at end as entered_at,
         case when t.origin = 'PLANNED' then execution.recorded_at else facts.first_recorded_at end as recorded_at,
         case when t.origin = 'PLANNED' then execution.quantity else facts.quantity end as quantity,
         case when t.origin = 'PLANNED' then case when plan.id is not null then planned.stop end else facts.initial_stop end as initial_stop,
         case when t.origin = 'PLANNED' then plan.nominal_risk
              when unplanned_close.trade_id is not null then unplanned_close.risk_basis
              else coalesce(facts.risk_amount,
                            abs(facts.entry_price - facts.initial_stop) * instrument.tick_value * facts.quantity / instrument.tick_size)
         end as initial_risk,
         case when t.origin = 'PLANNED'
              then abs(execution.entry_price - planned.stop) * instrument.tick_value * execution.quantity / instrument.tick_size
              else abs(facts.entry_price - facts.initial_stop) * instrument.tick_value * facts.quantity / instrument.tick_size
         end as actual_risk
) entry
cross join lateral (
  select min(ev.recorded_at) filter (where ev.event = 'DRAFT_DISCARDED') as discarded_at,
         (array_agg(ev.event order by ev.recorded_at desc, ev.id desc) filter (where ev.event <> 'DRAFT_DISCARDED'))[1] as review_state,
         max(ev.recorded_at) filter (where ev.event = 'REVIEW_COMPLETED') as last_completed_at
    from public.trade_lifecycle_events ev where ev.trade_id = t.id
) events
left join lateral (
  select h.decision from public.setup_human_decisions h
    join public.trade_revisions r on r.proposal_id = h.proposal_id
   where r.trade_id = t.id
   order by h.recorded_at desc, h.id desc limit 1
) decision on true
-- Plan-linked trades follow the V1 journal_analytics order: outcome, fill, disposition, then a latest legacy V1
-- SKIPPED decision, which keeps its V1 meaning before and after a lock.
cross join lateral (
  select case
    when t.origin = 'PLANNED' then case
      when events.discarded_at is not null then 'DISCARDED'
      when link.trade_id is null then case when decision.decision = 'SKIPPED' then 'SKIPPED' else 'DRAFT' end
      when outcome.id is not null then case when events.review_state = 'REVIEW_COMPLETED' then 'REVIEWED' else 'CLOSED' end
      when execution.id is not null then 'LIVE'
      when disposition.status is not null then disposition.status
      when decision.decision = 'SKIPPED' then 'SKIPPED'
      else 'LOCKED' end
    when unplanned_close.trade_id is not null then case when events.review_state = 'REVIEW_COMPLETED' then 'REVIEWED' else 'CLOSED' end
    else 'LIVE'
  end as lifecycle
) state
left join lateral (
  select s.setup_grade, s.liquidity_context, s.mss_timeframe, s.tags from public.trade_tag_sets s
   where s.trade_id = t.id order by s.id desc limit 1
) tag_set on true
left join lateral (
  select r.id, r.setup_grade, r.liquidity_context, r.mss_timeframe from public.trade_tag_revisions r
   where r.plan_id = link.plan_id order by r.id desc limit 1
) legacy_tags on true
cross join lateral (
  select count(*)::int as active_count, (array_agg(e.id order by e.recorded_at, e.id))[1] as first_id
    from public.trade_evidence e
   where e.trade_id = t.id and not exists (select 1 from public.trade_evidence_removals x where x.evidence_id = e.id)
) evidence
cross join lateral (
  select count(*)::int as active_count, (array_agg(s.id order by s.uploaded_at, s.id))[1] as first_id
    from public.trade_revisions r
    join public.setup_screenshots s on s.proposal_id = r.proposal_id
   where r.trade_id = t.id and not exists (select 1 from public.setup_screenshot_removals x where x.screenshot_id = s.id)
) legacy_evidence
cross join lateral (
  select ((select count(*) from public.trade_journal_entries j where j.trade_id = t.id)
        + (select count(*) from public.trade_events te
            where te.user_id = t.user_id and te.plan_id = link.plan_id and te.event_type = 'NOTE_ADDED'
              and coalesce(te.payload ->> 'source', '') <> 'MANUAL'))::int as entry_count
) journal
cross join lateral (
  select count(*)::int as review_count from public.trade_ai_reviews ar
    join public.trade_ai_review_results rr on rr.review_id = ar.id
   where ar.plan_id = link.plan_id and rr.status = 'COMPLETED'
) ai_reviews;
revoke all on public.trade_ledger from public, anon, authenticated, service_role;
grant select on public.trade_ledger to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Private helpers (never executable by API roles; called from security-definer RPCs).
-- ---------------------------------------------------------------------------------------------------------
create function private.require_object(p_value jsonb, p_allowed text[], p_what text) returns void
language plpgsql immutable set search_path = '' as $$
declare v_unknown text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'INVALID_INPUT: % must be a JSON object', p_what;
  end if;
  select k into v_unknown from jsonb_object_keys(p_value) as k where k <> all (p_allowed) order by k limit 1;
  if v_unknown is not null then raise exception 'INVALID_INPUT: unknown field "%" in %', v_unknown, p_what; end if;
end $$;

-- Text of an optional string field. Absent keys and JSON null are null; any other JSON type is rejected.
create function private.json_text(p_value jsonb, p_key text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_value -> p_key is null or jsonb_typeof(p_value -> p_key) = 'null' then return null; end if;
  if jsonb_typeof(p_value -> p_key) <> 'string' then raise exception 'INVALID_INPUT: % must be a string', p_key; end if;
  return p_value ->> p_key;
end $$;

-- Casts only run after the pattern matched: SQL does not guarantee the evaluation order of OR operands.
create function private.integer_input(p_value jsonb, p_key text, p_min bigint, p_max bigint) returns bigint
language plpgsql immutable set search_path = '' as $$
declare v_text text := p_value ->> p_key;
begin
  if v_text is null then return null; end if;
  if jsonb_typeof(p_value -> p_key) in ('number','string') and v_text ~ '^[0-9]{1,15}$' then
    if v_text::bigint between p_min and p_max then return v_text::bigint; end if;
  end if;
  raise exception 'INVALID_INPUT: % must be a whole number from % to %', p_key, p_min, p_max;
end $$;

create function private.uuid_input(p_value text, p_field text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then return null; end if;
  if p_value !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'INVALID_INPUT: % must be a UUID', p_field;
  end if;
  return p_value::uuid;
end $$;

create function private.decimal_input(p_value text, p_field text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then return null; end if;
  if p_value ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then
    if p_value::numeric > 0 then return p_value::numeric; end if;
  end if;
  raise exception 'INVALID_INPUT: % must be a positive decimal with up to 8 decimal places', p_field;
end $$;

create function private.money_input(p_value text, p_field text, p_allow_zero boolean default false) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then return null; end if;
  if p_value ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then
    if p_value::numeric > 0 or (p_allow_zero and p_value::numeric = 0) then return p_value::numeric; end if;
  end if;
  raise exception 'INVALID_INPUT: % must be % amount with up to 2 decimal places', p_field,
    case when p_allow_zero then 'a non-negative' else 'a positive' end;
end $$;

create function private.signed_money_input(p_value text, p_field text) returns numeric
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then return null; end if;
  if p_value !~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$' then
    raise exception 'INVALID_INPUT: % must be a signed amount with up to 2 decimal places', p_field;
  end if;
  return p_value::numeric;
end $$;

-- ISO 8601 instant with an explicit zone. Keywords accepted by the timestamptz cast ('now', 'epoch',
-- 'infinity', ...) are rejected by the pattern.
create function private.instant_input(p_value text, p_field text) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare v_instant timestamptz;
begin
  if p_value is null then return null; end if;
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    raise exception 'INVALID_INPUT: % must be an ISO 8601 timestamp with a time zone', p_field;
  end if;
  begin
    v_instant := p_value::timestamptz;
  exception when others then
    raise exception 'INVALID_INPUT: % is not a valid timestamp', p_field;
  end;
  return v_instant;
end $$;

-- Prefixes the stable messages raised by delegated V1 functions; unknown messages pass through unchanged.
create function private.v1_error_message(p_message text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_message like 'Account or risk plan changed%' then 'CONTEXT_CHANGED: '
    when p_message in ('Invalid proposal', 'Invalid decimal input', 'Value must be positive',
                       'Money requires up to two decimal places', 'Lock request key required')
      or p_message like 'Fees must be%' then 'INVALID_INPUT: '
    when p_message like 'Account configuration is incomplete%' then 'ACCOUNT_INCOMPLETE: '
    when p_message like 'Idempotency%' then 'IDEMPOTENCY_CONFLICT: '
    when p_message like 'Entry already recorded%' then 'ENTRY_ALREADY_RECORDED: '
    when p_message like 'Plan is skipped or cancelled%' then 'PLAN_DISPOSED: '
    when p_message like 'Entry must be after plan lock%' or p_message like 'Exit must be after entry%' then 'INVALID_TIME: '
    when p_message like 'Fill must align%' or p_message like 'Exit must align%' then 'OFF_INCREMENT: '
    when p_message like 'Actual entry must remain%' then 'ENTRY_BEYOND_STOP: '
    when p_message like 'Trade already closed%' then 'ALREADY_CLOSED: '
    when p_message like 'Record the actual entry%' then 'ENTRY_REQUIRED: '
    when p_message like 'Multi-leg position%' then 'MULTI_LEG: '
    when p_message like 'An executed trade must be closed%' then 'ALREADY_EXECUTED: '
    when p_message like 'Attached strategy is not supported%' then 'STRATEGY_UNSUPPORTED: '
    else ''
  end || p_message
$$;

create function private.lock_owned_account(p_account_id uuid) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare a public.accounts;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into a from public.accounts where id = p_account_id and user_id = auth.uid() for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND: Account not found'; end if;
  return a;
end $$;

-- The caller's trade, row-locked. Writes that affect reservations or daily usage lock the account row first,
-- the same order every V1 RPC uses.
create function private.lock_owned_trade(p_trade_id uuid, p_lock_account boolean) returns public.trades
language plpgsql security definer set search_path = '' as $$
declare t public.trades;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into t from public.trades where id = p_trade_id and user_id = auth.uid();
  if not found then raise exception 'TRADE_NOT_FOUND: Trade not found'; end if;
  if p_lock_account then perform 1 from public.accounts where id = t.account_id for update; end if;
  select * into t from public.trades where id = t.id for update;
  return t;
end $$;

create function private.latest_revision(p_trade_id uuid) returns public.trade_revisions
language sql stable security definer set search_path = '' as $$
  select r.* from public.trade_revisions r where r.trade_id = p_trade_id order by r.revision desc limit 1
$$;

create function private.linked_plan(p_trade public.trades) returns public.trade_plans
language plpgsql stable security definer set search_path = '' as $$
declare p public.trade_plans;
begin
  select tp.* into p from public.trade_plan_links l join public.trade_plans tp on tp.id = l.plan_id where l.trade_id = p_trade.id;
  if not found then raise exception 'PLAN_REQUIRED: This trade has no locked plan'; end if;
  return p;
end $$;

-- §2.2 lifecycle, read from the ledger so SQL has a single definition.
create function private.trade_lifecycle(p_trade_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select l.lifecycle from public.trade_ledger l where l.id = p_trade_id
$$;

-- §5.2 stored phase: a close exists → POST_TRADE; an entry exists (planned execution, or any trade without a
-- Trading OS plan, which is live from creation) → LIVE; otherwise PRE_ENTRY.
create function private.trade_phase(p_trade_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.trade_unplanned_closes c where c.trade_id = t.id)
      or exists (select 1 from public.trade_plan_links l join public.trade_outcomes o on o.plan_id = l.plan_id where l.trade_id = t.id)
      then 'POST_TRADE'
    when t.origin <> 'PLANNED'
      or exists (select 1 from public.trade_plan_links l join public.trade_executions e on e.plan_id = l.plan_id where l.trade_id = t.id)
      then 'LIVE'
    else 'PRE_ENTRY'
  end
  from public.trades t where t.id = p_trade_id
$$;

-- Effective entry facts of a trade without a plan: identity, source and recorded_at of the first row, and for
-- every fact the first non-null value in (recorded_at, id) order. A trade without facts yields all nulls.
create function private.effective_position(p_trade_id uuid) returns public.trade_position_facts
language plpgsql stable security definer set search_path = '' as $$
declare v public.trade_position_facts; f public.trade_position_facts;
begin
  for f in select * from public.trade_position_facts where trade_id = p_trade_id order by recorded_at, id loop
    if v.id is null then
      v := f;
    else
      v.instrument_version_id := coalesce(v.instrument_version_id, f.instrument_version_id);
      v.symbol := coalesce(v.symbol, f.symbol);
      v.direction := coalesce(v.direction, f.direction);
      v.entry_model := coalesce(v.entry_model, f.entry_model);
      v.entry_price := coalesce(v.entry_price, f.entry_price);
      v.entered_at := coalesce(v.entered_at, f.entered_at);
      v.quantity := coalesce(v.quantity, f.quantity);
      v.initial_stop := coalesce(v.initial_stop, f.initial_stop);
      v.risk_amount := coalesce(v.risk_amount, f.risk_amount);
    end if;
  end loop;
  return v;
end $$;

-- §3.5 for every writer (user RPCs and imports): the first facts row of a trade carries symbol and direction;
-- later rows only add facts that are still unknown, so a recorded fact is never changed.
create function private.guard_position_facts() returns trigger
language plpgsql set search_path = '' as $$
declare cur public.trade_position_facts;
begin
  cur := private.effective_position(new.trade_id);
  if cur.id is null then
    if new.symbol is null or new.direction is null then
      raise exception 'INVALID_INPUT: The first entry facts of a trade need a symbol and a direction';
    end if;
  elsif new.symbol is not null or new.direction is not null
     or (new.instrument_version_id is not null and cur.instrument_version_id is not null)
     or (new.entry_model is not null and cur.entry_model is not null)
     or (new.entry_price is not null and cur.entry_price is not null)
     or (new.entered_at is not null and cur.entered_at is not null)
     or (new.quantity is not null and cur.quantity is not null)
     or (new.initial_stop is not null and cur.initial_stop is not null)
     or (new.risk_amount is not null and cur.risk_amount is not null) then
    raise exception 'ENTRY_DETAILS_IMMUTABLE: Recorded entry details cannot be changed';
  end if;
  return new;
end $$;
create trigger position_facts_guard before insert on public.trade_position_facts
  for each row execute function private.guard_position_facts();

-- Contract the trade is valued in: the locked plan's, else the latest revision's, else the effective facts'.
create function private.trade_instrument(p_trade public.trades) returns public.instrument_versions
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; i public.instrument_versions;
begin
  if p_trade.origin = 'PLANNED' then
    select p.instrument_version_id into v_id
      from public.trade_plan_links l join public.trade_plans p on p.id = l.plan_id where l.trade_id = p_trade.id;
    if v_id is null then
      select s.instrument_version_id into v_id
        from public.trade_revisions r join public.setup_proposals s on s.id = r.proposal_id
       where r.trade_id = p_trade.id order by r.revision desc limit 1;
    end if;
  else
    v_id := (private.effective_position(p_trade.id)).instrument_version_id;
  end if;
  select * into i from public.instrument_versions where id = v_id;
  return i;
end $$;

-- A draft proposal must be a JSON object naming an instrument of the account; the V1 engine validates the rest
-- (an unparseable proposal is rejected by save_setup_proposal, a parseable one is saved with its BLOCKED report).
create function private.check_draft_proposal(p_account_id uuid, p_proposal jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_instrument text;
begin
  if p_proposal is null or jsonb_typeof(p_proposal) <> 'object' then
    raise exception 'INVALID_INPUT: proposal must be a JSON object';
  end if;
  if jsonb_typeof(p_proposal -> 'instrumentId') = 'string' then
    v_instrument := p_proposal ->> 'instrumentId';
    if v_instrument ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      if exists (select 1 from public.instrument_versions i where i.account_id = p_account_id and i.id = v_instrument::uuid) then
        return;
      end if;
    end if;
  end if;
  raise exception 'INVALID_INPUT: instrumentId must reference an instrument of this account';
end $$;

-- save_setup_proposal (free deterministic check, persisted) with prefixed errors; returns the proposal row.
create function private.save_draft_proposal(p_account_id uuid, p_proposal jsonb, p_request_key uuid,
  p_expected_risk_id uuid, p_expected_observation_id uuid) returns public.setup_proposals
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v public.setup_proposals;
begin
  if exists (select 1 from public.setup_proposals where user_id = auth.uid() and request_key = p_request_key) then
    raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for another proposal';
  end if;
  begin
    v_id := public.save_setup_proposal(p_account_id, p_proposal, p_request_key, p_expected_risk_id, p_expected_observation_id);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
  select * into v from public.setup_proposals where id = v_id;
  return v;
end $$;

create function private.draft_envelope(p_trade_id uuid, p_proposal public.setup_proposals, p_revision int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tradeId', p_trade_id, 'proposalId', p_proposal.id, 'revision', p_revision,
                            'evaluationId', e.id, 'result', e.result)
    from public.risk_evaluations e where e.id = p_proposal.risk_evaluation_id
$$;

create function private.lifecycle_envelope(p_event public.trade_lifecycle_events) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tradeId', p_event.trade_id, 'eventId', p_event.id, 'event', p_event.event,
                            'recordedAt', p_event.recorded_at, 'lifecycle', private.trade_lifecycle(p_event.trade_id))
$$;

-- Parses the live-trade fields present in p_input (absent and null fields stay null). Field-level validation
-- only; private.check_position validates the combined effective state.
create function private.position_input(p_account public.accounts, p_input jsonb) returns public.trade_position_facts
language plpgsql stable security definer set search_path = '' as $$
declare v public.trade_position_facts; i public.instrument_versions; v_instrument uuid; v_symbol text;
begin
  v_instrument := private.uuid_input(private.json_text(p_input, 'instrumentId'), 'instrumentId');
  if v_instrument is not null then
    select * into i from public.instrument_versions where account_id = p_account.id and id = v_instrument;
    if not found then raise exception 'INVALID_INPUT: instrumentId must reference an instrument of this account'; end if;
    v.instrument_version_id := i.id;
    v.symbol := i.symbol;
  end if;
  v_symbol := private.json_text(p_input, 'symbol');
  if v_symbol is not null then
    if v_symbol !~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$' then
      raise exception 'INVALID_INPUT: symbol must be 1 to 20 characters of A-Z, 0-9, ".", "_", "/" or "-"';
    end if;
    if v.symbol is not null and v.symbol <> v_symbol then
      raise exception 'INVALID_INPUT: symbol does not match the selected instrument';
    end if;
    v.symbol := v_symbol;
  end if;
  v.direction := private.json_text(p_input, 'direction');
  if v.direction not in ('LONG','SHORT') then raise exception 'INVALID_INPUT: direction must be LONG or SHORT'; end if;
  v.entry_model := private.json_text(p_input, 'entryModel');
  if v.entry_model not in ('OB_FIRST_TOUCH','OTE','OTHER') then
    raise exception 'INVALID_INPUT: entryModel must be OB_FIRST_TOUCH, OTE or OTHER';
  end if;
  v.entry_price := private.decimal_input(private.json_text(p_input, 'entryPrice'), 'entryPrice');
  v.entered_at := private.instant_input(private.json_text(p_input, 'enteredAt'), 'enteredAt');
  v.quantity := private.decimal_input(private.json_text(p_input, 'quantity'), 'quantity');
  v.initial_stop := private.decimal_input(private.json_text(p_input, 'initialStop'), 'initialStop');
  v.risk_amount := private.money_input(private.json_text(p_input, 'riskAmount'), 'riskAmount');
  return v;
end $$;

-- Combined rules of §3.5: entry time not after the trade was recorded; with a known contract, prices on the
-- tick grid and size on the step grid and at least the minimum; stop on the protective side of entry.
create function private.check_position(p public.trade_position_facts, p_entered_by timestamptz) returns void
language plpgsql stable security definer set search_path = '' as $$
declare i public.instrument_versions;
begin
  if p.entered_at > p_entered_by then
    raise exception 'INVALID_TIME: The entry time must not be later than when the trade was recorded';
  end if;
  if p.instrument_version_id is not null then
    select * into i from public.instrument_versions where id = p.instrument_version_id;
    if mod(p.entry_price, i.tick_size) <> 0 or mod(p.initial_stop, i.tick_size) <> 0 then
      raise exception 'OFF_INCREMENT: Entry and stop must align to the % tick size of %', i.symbol, trim_scale(i.tick_size);
    end if;
    if mod(p.quantity, i.quantity_step) <> 0 or p.quantity < i.minimum_quantity then
      raise exception 'OFF_INCREMENT: Size must be a multiple of % and at least %', trim_scale(i.quantity_step), trim_scale(i.minimum_quantity);
    end if;
  end if;
  if p.entry_price is not null and p.initial_stop is not null
     and not ((p.direction = 'LONG' and p.initial_stop < p.entry_price) or (p.direction = 'SHORT' and p.initial_stop > p.entry_price)) then
    raise exception 'INVALID_INPUT: The stop must be % the entry for a % trade',
      case when p.direction = 'LONG' then 'below' else 'above' end, lower(coalesce(p.direction, 'unknown'));
  end if;
end $$;

-- §3.6 details per kind. Unknown keys are rejected; decimals are JSON strings.
create function private.check_journal_details(p_kind text, p_body text, p_details jsonb, p_tick_size numeric) returns void
language plpgsql immutable set search_path = '' as $$
declare v_price numeric; v_quantity numeric; v_percent text;
begin
  if p_kind in ('NOTE','DECISION','LESSON') then
    perform private.require_object(p_details, array[]::text[], 'details');
    if p_body is null then raise exception 'INVALID_INPUT: A % needs a body', lower(p_kind); end if;
  elsif p_kind in ('STOP_CHANGE','TARGET_CHANGE') then
    perform private.require_object(p_details, array['price'], 'details');
    v_price := private.decimal_input(private.json_text(p_details, 'price'), 'price');
    if v_price is null then raise exception 'INVALID_INPUT: price is required'; end if;
    if mod(v_price, p_tick_size) <> 0 then raise exception 'INVALID_INPUT: price must align to the instrument tick size'; end if;
  elsif p_kind = 'PARTIAL_CLOSE' then
    perform private.require_object(p_details, array['price','quantity','percent'], 'details');
    v_price := private.decimal_input(private.json_text(p_details, 'price'), 'price');
    v_quantity := private.decimal_input(private.json_text(p_details, 'quantity'), 'quantity');
    v_percent := private.json_text(p_details, 'percent');
    if v_percent is not null and (v_percent !~ '^[0-9]{1,2}(\.[0-9]{1,8})?$' or v_percent ~ '^0+(\.0+)?$') then
      raise exception 'INVALID_INPUT: percent must be greater than 0 and less than 100';
    end if;
    if v_quantity is not null and v_percent is not null then
      raise exception 'INVALID_INPUT: Give either quantity or percent for a partial close, not both';
    end if;
    if p_body is null and p_details = '{}'::jsonb then
      raise exception 'INVALID_INPUT: A partial close needs a body or details';
    end if;
  else
    raise exception 'INVALID_INPUT: kind must be NOTE, DECISION, STOP_CHANGE, TARGET_CHANGE, PARTIAL_CLOSE or LESSON';
  end if;
end $$;

-- §3.10 precedence fix (V1 finding C9): among versions already in effect on p_day, the newest created wins.
create function private.active_risk_plan(p_account_id uuid, p_day date) returns public.risk_plan_versions
language sql stable security definer set search_path = '' as $$
  select r.* from public.risk_plan_versions r
   where r.account_id = p_account_id and r.effective_day <= p_day
   order by r.created_at desc, r.id desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.2 Trading-account RPCs.
-- ---------------------------------------------------------------------------------------------------------
-- Input {name, currency, accountType, platform, broker?, startingBalance?, balance, equity}. Replays compare the
-- normalized input under the same per-user advisory lock as bootstrap_demo_account (0003).
create function public.create_trading_account(p_request_key uuid, p_input jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_name text; v_currency text; v_type text; v_platform text; v_broker text;
  v_balance numeric; v_equity numeric; v_starting numeric;
  normalized jsonb; existing public.bootstrap_requests; v_account uuid;
  v_day date := private.strategy_day(clock_timestamp());
begin
  if uid is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  perform private.require_object(p_input,
    array['name','currency','accountType','platform','broker','startingBalance','balance','equity'], 'account');
  v_name := btrim(private.json_text(p_input, 'name'));
  if v_name is null or length(v_name) not between 1 and 100 then
    raise exception 'INVALID_INPUT: name must contain 1 to 100 characters';
  end if;
  v_currency := private.json_text(p_input, 'currency');
  if v_currency is null or not (v_currency = any (private.supported_currencies())) then
    raise exception 'INVALID_INPUT: currency is not supported';
  end if;
  v_type := private.json_text(p_input, 'accountType');
  if v_type is null or v_type not in ('DEMO','EVALUATION','FUNDED','PERSONAL','OTHER') then
    raise exception 'INVALID_INPUT: accountType must be DEMO, EVALUATION, FUNDED, PERSONAL or OTHER';
  end if;
  v_platform := private.json_text(p_input, 'platform');
  if v_platform is null or v_platform not in ('MANUAL','CTRADER','MT5','MT4','TRADINGVIEW','OTHER') then
    raise exception 'INVALID_INPUT: platform must be MANUAL, CTRADER, MT5, MT4, TRADINGVIEW or OTHER';
  end if;
  v_broker := nullif(btrim(private.json_text(p_input, 'broker')), '');
  if length(v_broker) > 100 then raise exception 'INVALID_INPUT: broker must contain at most 100 characters'; end if;
  v_balance := private.money_input(private.json_text(p_input, 'balance'), 'balance');
  v_equity := private.money_input(private.json_text(p_input, 'equity'), 'equity');
  if v_balance is null or v_equity is null then raise exception 'INVALID_INPUT: balance and equity are required'; end if;
  v_starting := coalesce(private.money_input(private.json_text(p_input, 'startingBalance'), 'startingBalance'), v_balance);
  normalized := jsonb_build_object('kind', 'TRADING_ACCOUNT', 'name', v_name, 'currency', v_currency, 'accountType', v_type,
    'platform', v_platform, 'broker', v_broker, 'startingBalance', v_starting, 'balance', v_balance, 'equity', v_equity);
  perform pg_advisory_xact_lock(hashtextextended(uid::text || p_request_key::text, 0));
  select * into existing from public.bootstrap_requests where user_id = uid and idempotency_key = p_request_key;
  if found then
    if existing.input <> normalized then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different account';
    end if;
    return existing.account_id;
  end if;
  insert into public.accounts(user_id, name, currency) values (uid, v_name, v_currency) returning id into v_account;
  insert into public.account_observations(user_id, account_id, equity, balance, trading_day)
    values (uid, v_account, v_equity, v_balance, v_day);
  perform private.seed_ict_strategy(uid, v_account);
  insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
      max_daily_trades, min_rr, rr_policy, news_policy)
    values (uid, v_account, 'Risk Plan V1.0', v_day, 0.5, 0.5, 2, 3, 'BLOCK', 'WARN');
  if v_currency = 'USD' then
    insert into public.instrument_versions(user_id, account_id, symbol, currency, quantity_unit, tick_size, pip_size, tick_value,
        quantity_step, minimum_quantity)
      values (uid, v_account, 'EURUSD', 'USD', 'lots (100,000 EUR)', 0.00001, 0.0001, 1, 0.01, 0.01),
             (uid, v_account, 'GBPUSD', 'USD', 'lots (100,000 GBP)', 0.00001, 0.0001, 1, 0.01, 0.01);
  end if;
  insert into public.configuration_events(user_id, account_id, event_type, payload)
    values (uid, v_account, 'ACCOUNT_INITIALIZED', jsonb_build_object('strategy', 'ICT V1.0', 'risk_plan', 'Risk Plan V1.0',
      'currency', v_currency, 'account_type', v_type, 'platform', v_platform));
  insert into public.account_profiles(user_id, account_id, display_name, broker, platform, account_type, starting_balance, status, source)
    values (uid, v_account, v_name, v_broker, v_platform, v_type, v_starting, 'ACTIVE', 'USER');
  insert into public.bootstrap_requests(user_id, idempotency_key, account_id, input) values (uid, p_request_key, v_account, normalized);
  return v_account;
end $$;

-- Any subset of {displayName, broker, platform, accountType, startingBalance, status}; missing keys copy the
-- latest revision (or, for accounts created by bootstrap_demo_account after 0015, their implicit defaults).
-- broker/startingBalance may be cleared with null. Returns the latest revision id; unchanged input is a no-op.
create function public.update_account_profile(p_account_id uuid, p_input jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare a public.accounts; cur public.account_profiles; nxt public.account_profiles; v_id bigint;
begin
  a := private.lock_owned_account(p_account_id);
  perform private.require_object(p_input, array['displayName','broker','platform','accountType','startingBalance','status'], 'profile');
  select * into cur from public.account_profiles where account_id = a.id order by id desc limit 1;
  if not found then
    cur.display_name := a.name;
    cur.platform := 'MANUAL';
    cur.account_type := 'DEMO';
    cur.status := 'ACTIVE';
    select o.balance into cur.starting_balance from public.account_observations o
     where o.account_id = a.id order by o.recorded_at, o.id limit 1;
  end if;
  nxt := cur;
  if p_input ? 'displayName' then
    nxt.display_name := btrim(private.json_text(p_input, 'displayName'));
    if nxt.display_name is null or length(nxt.display_name) not between 1 and 100 then
      raise exception 'INVALID_INPUT: displayName must contain 1 to 100 characters';
    end if;
  end if;
  if p_input ? 'broker' then
    nxt.broker := nullif(btrim(private.json_text(p_input, 'broker')), '');
    if length(nxt.broker) > 100 then raise exception 'INVALID_INPUT: broker must contain at most 100 characters'; end if;
  end if;
  if p_input ? 'platform' then
    nxt.platform := private.json_text(p_input, 'platform');
    if nxt.platform is null or nxt.platform not in ('MANUAL','CTRADER','MT5','MT4','TRADINGVIEW','OTHER') then
      raise exception 'INVALID_INPUT: platform must be MANUAL, CTRADER, MT5, MT4, TRADINGVIEW or OTHER';
    end if;
  end if;
  if p_input ? 'accountType' then
    nxt.account_type := private.json_text(p_input, 'accountType');
    if nxt.account_type is null or nxt.account_type not in ('DEMO','EVALUATION','FUNDED','PERSONAL','OTHER') then
      raise exception 'INVALID_INPUT: accountType must be DEMO, EVALUATION, FUNDED, PERSONAL or OTHER';
    end if;
  end if;
  if p_input ? 'startingBalance' then
    nxt.starting_balance := private.money_input(private.json_text(p_input, 'startingBalance'), 'startingBalance');
  end if;
  if p_input ? 'status' then
    nxt.status := private.json_text(p_input, 'status');
    if nxt.status is null or nxt.status not in ('ACTIVE','ARCHIVED') then
      raise exception 'INVALID_INPUT: status must be ACTIVE or ARCHIVED';
    end if;
  end if;
  if cur.id is not null
     and (nxt.display_name, nxt.broker, nxt.platform, nxt.account_type, nxt.starting_balance, nxt.status)
         is not distinct from (cur.display_name, cur.broker, cur.platform, cur.account_type, cur.starting_balance, cur.status) then
    return cur.id;
  end if;
  insert into public.account_profiles(user_id, account_id, display_name, broker, platform, account_type, starting_balance, status, source)
    values (a.user_id, a.id, nxt.display_name, nxt.broker, nxt.platform, nxt.account_type, nxt.starting_balance, nxt.status, 'USER')
    returning id into v_id;
  return v_id;
end $$;

-- {symbol, quantityUnit, tickSize, pipSize?, tickValue, quantityStep, minimumQuantity}. The contract is valued in
-- the account currency. A newer version of a symbol supersedes older ones in pickers; history keeps its version.
create function public.create_instrument_version(p_account_id uuid, p_input jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts; v_symbol text; v_unit text;
  v_tick numeric; v_pip numeric; v_value numeric; v_step numeric; v_minimum numeric; v_id uuid;
begin
  a := private.lock_owned_account(p_account_id);
  perform private.require_object(p_input,
    array['symbol','quantityUnit','tickSize','pipSize','tickValue','quantityStep','minimumQuantity'], 'instrument');
  v_symbol := private.json_text(p_input, 'symbol');
  if v_symbol is null or v_symbol !~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$' then
    raise exception 'INVALID_INPUT: symbol must be 1 to 20 characters of A-Z, 0-9, ".", "_", "/" or "-"';
  end if;
  v_unit := btrim(private.json_text(p_input, 'quantityUnit'));
  if v_unit is null or length(v_unit) not between 1 and 60 then
    raise exception 'INVALID_INPUT: quantityUnit must contain 1 to 60 characters';
  end if;
  v_tick := private.decimal_input(private.json_text(p_input, 'tickSize'), 'tickSize');
  v_pip := private.decimal_input(private.json_text(p_input, 'pipSize'), 'pipSize');
  v_value := private.decimal_input(private.json_text(p_input, 'tickValue'), 'tickValue');
  v_step := private.decimal_input(private.json_text(p_input, 'quantityStep'), 'quantityStep');
  v_minimum := private.decimal_input(private.json_text(p_input, 'minimumQuantity'), 'minimumQuantity');
  if v_tick is null or v_value is null or v_step is null or v_minimum is null then
    raise exception 'INVALID_INPUT: tickSize, tickValue, quantityStep and minimumQuantity are required';
  end if;
  insert into public.instrument_versions(user_id, account_id, symbol, currency, quantity_unit, tick_size, pip_size, tick_value,
      quantity_step, minimum_quantity, source)
    values (a.user_id, a.id, v_symbol, a.currency, v_unit, v_tick, v_pip, v_value, v_step, v_minimum, 'USER_DEFINED')
    returning id into v_id;
  insert into public.configuration_events(user_id, account_id, event_type, payload)
    values (a.user_id, a.id, 'INSTRUMENT_VERSION_CREATED',
            jsonb_build_object('instrument_version_id', v_id, 'symbol', v_symbol, 'currency', a.currency));
  return v_id;
end $$;

create function public.record_account_values(p_account_id uuid, p_balance text, p_equity text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_owned_account(p_account_id);
  begin
    return public.record_observation(p_account_id, p_equity, p_balance, null);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.4 Planned-trade RPCs.
-- ---------------------------------------------------------------------------------------------------------
create function public.create_planned_trade(p_account_id uuid, p_proposal jsonb, p_request_key uuid,
  p_expected_risk_id uuid, p_expected_observation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.accounts; t public.trades; v_proposal public.setup_proposals; v_trade uuid;
begin
  a := private.lock_owned_account(p_account_id);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  select * into t from public.trades where user_id = a.user_id and request_key = p_request_key;
  if found then
    select s.* into v_proposal from public.trade_revisions r join public.setup_proposals s on s.id = r.proposal_id
     where r.trade_id = t.id and r.revision = 1;
    if t.account_id <> a.id or t.origin <> 'PLANNED' or t.duplicated_from is not null
       or v_proposal.proposal is distinct from p_proposal then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different trade';
    end if;
    return private.draft_envelope(t.id, v_proposal, 1);
  end if;
  perform private.check_draft_proposal(a.id, p_proposal);
  v_proposal := private.save_draft_proposal(a.id, p_proposal, p_request_key, p_expected_risk_id, p_expected_observation_id);
  insert into public.trades(user_id, account_id, origin, request_key)
    values (a.user_id, a.id, 'PLANNED', p_request_key) returning id into v_trade;
  insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id)
    values (v_proposal.id, v_trade, 1, a.user_id, a.id);
  return private.draft_envelope(v_trade, v_proposal, 1);
end $$;

create function public.revise_trade_draft(p_trade_id uuid, p_proposal jsonb, p_request_key uuid, p_expected_revision int,
  p_expected_risk_id uuid, p_expected_observation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; replayed public.trade_revisions; latest public.trade_revisions; v_proposal public.setup_proposals;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  select r.* into replayed from public.trade_revisions r join public.setup_proposals s on s.id = r.proposal_id
   where r.trade_id = t.id and s.user_id = t.user_id and s.request_key = p_request_key;
  if found then
    select * into v_proposal from public.setup_proposals where id = replayed.proposal_id;
    if v_proposal.proposal is distinct from p_proposal then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different revision';
    end if;
    return private.draft_envelope(t.id, v_proposal, replayed.revision);
  end if;
  if private.trade_lifecycle(t.id) <> 'DRAFT' then
    raise exception 'DRAFT_NOT_EDITABLE: Only drafts can be revised';
  end if;
  latest := private.latest_revision(t.id);
  if latest.revision is distinct from p_expected_revision then
    raise exception 'DRAFT_CHANGED: The draft changed since it was loaded (latest revision %)', coalesce(latest.revision::text, 'none');
  end if;
  perform private.check_draft_proposal(t.account_id, p_proposal);
  v_proposal := private.save_draft_proposal(t.account_id, p_proposal, p_request_key, p_expected_risk_id, p_expected_observation_id);
  insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id)
    values (v_proposal.id, t.id, latest.revision + 1, t.user_id, t.account_id);
  return private.draft_envelope(t.id, v_proposal, latest.revision + 1);
end $$;

-- Copies the latest revision (or the plan's proposal) with news reset to UNKNOWN: news must be re-verified.
-- Evidence is copied afterwards by the trusted server (§7.4).
create function public.duplicate_trade_draft(p_trade_id uuid, p_request_key uuid, p_expected_risk_id uuid,
  p_expected_observation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare original public.trades; t public.trades; latest public.trade_revisions; v_source jsonb; v_proposal public.setup_proposals; v_trade uuid;
begin
  original := private.lock_owned_trade(p_trade_id, true);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  select * into t from public.trades where user_id = original.user_id and request_key = p_request_key;
  if found then
    if t.duplicated_from is distinct from original.id then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different trade';
    end if;
    return jsonb_build_object('tradeId', t.id,
      'proposalId', (select r.proposal_id from public.trade_revisions r where r.trade_id = t.id and r.revision = 1));
  end if;
  latest := private.latest_revision(original.id);
  if latest.proposal_id is not null then
    select s.proposal into v_source from public.setup_proposals s where s.id = latest.proposal_id;
  else
    select p.proposal into v_source from public.trade_plan_links l join public.trade_plans p on p.id = l.plan_id
     where l.trade_id = original.id;
  end if;
  if v_source is null then
    raise exception 'NO_PLAN_TO_DUPLICATE: Only trades with a draft or a locked plan can be duplicated';
  end if;
  v_source := v_source || jsonb_build_object('news', 'UNKNOWN');
  v_proposal := private.save_draft_proposal(original.account_id, v_source, p_request_key, p_expected_risk_id, p_expected_observation_id);
  insert into public.trades(user_id, account_id, origin, request_key, duplicated_from)
    values (original.user_id, original.account_id, 'PLANNED', p_request_key, original.id) returning id into v_trade;
  insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id)
    values (v_proposal.id, v_trade, 1, original.user_id, original.account_id);
  return jsonb_build_object('tradeId', v_trade, 'proposalId', v_proposal.id);
end $$;

create function public.discard_trade_draft(p_trade_id uuid, p_reason text, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; e public.trade_lifecycle_events; v_reason text := nullif(btrim(p_reason), '');
begin
  t := private.lock_owned_trade(p_trade_id, false);
  if length(v_reason) > 2000 then raise exception 'INVALID_INPUT: reason must contain at most 2000 characters'; end if;
  if p_request_key is not null then
    select * into e from public.trade_lifecycle_events where user_id = t.user_id and request_key = p_request_key;
    if found then
      if e.trade_id <> t.id or e.event <> 'DRAFT_DISCARDED' or e.reason is distinct from v_reason then
        raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different action';
      end if;
      return private.lifecycle_envelope(e);
    end if;
  end if;
  select * into e from public.trade_lifecycle_events where trade_id = t.id and event = 'DRAFT_DISCARDED'
   order by recorded_at limit 1;
  if found then return private.lifecycle_envelope(e); end if;
  if private.trade_lifecycle(t.id) <> 'DRAFT' then
    raise exception 'DRAFT_NOT_EDITABLE: Only drafts can be discarded';
  end if;
  insert into public.trade_lifecycle_events(user_id, account_id, trade_id, event, reason, request_key)
    values (t.user_id, t.account_id, t.id, 'DRAFT_DISCARDED', v_reason, p_request_key) returning * into e;
  return private.lifecycle_envelope(e);
end $$;

-- §10.4 check_setup_risk stays granted but is trade-aware. Locking a proposal that is a revision of a trade is
-- allowed only for the latest revision of a DRAFT trade, and the resulting plan is linked to the trade, so no caller
-- can reserve a slot or record fills outside the trade model. Rechecks (p_lock false), exact replays of a lock and
-- proposals outside the trade model return exactly what V1 returned; a plan locked from a proposal outside the trade
-- model is additionally wrapped into a new PLANNED trade (§2.1: every plan belongs to exactly one trade).
-- create or replace keeps the function's OID and grants.
--
-- The 0004 body of public.check_setup_risk, verbatim: risk check (and optional lock) of one proposal, unaware of
-- trades. An engine change replaces this function and leaves the trade-aware wrapper below in place.
create function private.check_proposal_risk(p_proposal_id uuid, p_lock boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.setup_proposals; r uuid; o uuid; result jsonb; linked uuid;
 a public.accounts; obs public.account_observations; rp public.risk_plan_versions; inst public.instrument_versions;
 now_at timestamptz; slots integer; consumed numeric; duplicate boolean; report jsonb; rid uuid;
begin
 select * into v from public.setup_proposals where id=p_proposal_id and user_id=auth.uid();
 if not found then raise exception 'Proposal not found'; end if;
 perform 1 from public.accounts where id=v.account_id for update;
 select plan_id into linked from public.setup_locks where proposal_id=v.id;
 if linked is not null then
   if not p_lock then
     now_at:=clock_timestamp();
     select * into a from public.accounts where id=v.account_id;
     select * into obs from public.account_observations where account_id=v.account_id order by recorded_at desc,id desc limit 1;
     select * into rp from public.risk_plan_versions where account_id=v.account_id and effective_day<=private.strategy_day(now_at) order by effective_day desc,created_at desc,id desc limit 1;
     select * into inst from public.instrument_versions where id=v.instrument_version_id;
     if not exists(select 1 from public.strategy_versions where id=v.strategy_version_id and version='ICT V1.0') then raise exception 'Attached strategy is not supported by this risk engine'; end if;
     -- Recheck a reserved plan without double-counting its own reservation.
     select count(*),coalesce(sum(nominal_risk),0) into slots,consumed from public.trade_plans where account_id=v.account_id and trading_day=private.strategy_day(now_at) and id<>linked;
     select exists(select 1 from public.trade_plans p where p.account_id=v.account_id and p.trading_day=private.strategy_day(now_at) and p.id<>linked
       and p.instrument_version_id=v.instrument_version_id and p.proposal->>'direction'=v.proposal->>'direction' and p.proposal->>'model'=v.proposal->>'model'
       and (p.proposal->>'entry')::numeric=(v.proposal->>'entry')::numeric and (p.proposal->>'stop')::numeric=(v.proposal->>'stop')::numeric and (p.proposal->>'target')::numeric=(v.proposal->>'target')::numeric) into duplicate;
     report:=private.risk_report(v.proposal,a,obs,rp,inst,v.strategy_version_id,now_at,slots,consumed,duplicate);
     insert into public.risk_evaluations(user_id,account_id,proposal,result,account_observation_id,strategy_version_id,risk_plan_version_id,instrument_version_id,source)
       values(v.user_id,v.account_id,v.proposal,report,obs.id,v.strategy_version_id,rp.id,inst.id,'EXPLICIT_CHECK') returning id into rid;
     insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,rid);
     return jsonb_build_object('planId',linked,'evaluationId',rid,'result',report,'replayed',false);
   end if;
   select jsonb_build_object('planId',id,'evaluationId',risk_evaluation_id,'result',risk_result,'replayed',true) into result from public.trade_plans where id=linked;
   return result;
 end if;
 select id into r from public.risk_plan_versions where account_id=v.account_id and effective_day<=private.strategy_day(clock_timestamp()) order by effective_day desc,created_at desc,id desc limit 1;
 select id into o from public.account_observations where account_id=v.account_id order by recorded_at desc,id desc limit 1;
 result:=private.assess_plan(v.account_id,v.proposal,v.id,r,o,p_lock);
 -- Current deterministic engine supports ICT V1.0 only. Never retarget a future attached strategy.
 if (result#>>'{result,strategyVersionId}')::uuid<>v.strategy_version_id then raise exception 'Attached strategy is not supported by this risk engine'; end if;
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,(result->>'evaluationId')::uuid);
 if result->>'planId' is not null then
   insert into public.setup_locks(user_id,account_id,proposal_id,plan_id) values(v.user_id,v.account_id,v.id,(result->>'planId')::uuid);
 end if;
 return result;
end $$;

create or replace function public.check_setup_risk(p_proposal_id uuid, p_lock boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_trade_id uuid; t public.trades; latest public.trade_revisions; v_result jsonb;
  v_proposal public.setup_proposals; v_wrapped uuid;
begin
  if p_lock then
    select r.trade_id into v_trade_id from public.trade_revisions r where r.proposal_id = p_proposal_id and r.user_id = auth.uid();
    if v_trade_id is not null then
      t := private.lock_owned_trade(v_trade_id, true);
      if not exists (select 1 from public.setup_locks l where l.proposal_id = p_proposal_id) then
        if private.trade_lifecycle(t.id) <> 'DRAFT' then
          raise exception 'DRAFT_NOT_EDITABLE: Only drafts can be locked';
        end if;
        latest := private.latest_revision(t.id);
        if latest.proposal_id <> p_proposal_id then
          raise exception 'DRAFT_CHANGED: The draft changed since it was loaded (latest revision %)', latest.revision;
        end if;
      end if;
    end if;
  end if;
  v_result := private.check_proposal_risk(p_proposal_id, p_lock);
  if t.id is not null and v_result ->> 'planId' is not null then
    insert into public.trade_plan_links(trade_id, plan_id, user_id, account_id)
      values (t.id, (v_result ->> 'planId')::uuid, t.user_id, t.account_id)
      on conflict (trade_id) do nothing;
  elsif p_lock and v_trade_id is null and v_result ->> 'planId' is not null
        and not exists (select 1 from public.trade_plan_links pl where pl.plan_id = (v_result ->> 'planId')::uuid) then
    -- A proposal saved outside the trade model (V1 save_setup_proposal) was locked. Wrap it into a PLANNED
    -- trade so every plan belongs to exactly one trade; insert-only, dated by the proposal itself.
    select * into v_proposal from public.setup_proposals where id = p_proposal_id;
    insert into public.trades(user_id, account_id, origin, created_at)
      values (v_proposal.user_id, v_proposal.account_id, 'PLANNED', v_proposal.created_at)
      returning id into v_wrapped;
    insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id, created_at)
      values (v_proposal.id, v_wrapped, 1, v_proposal.user_id, v_proposal.account_id, v_proposal.created_at);
    insert into public.trade_plan_links(trade_id, plan_id, user_id, account_id)
      values (v_wrapped, (v_result ->> 'planId')::uuid, v_proposal.user_id, v_proposal.account_id);
  end if;
  return v_result;
end $$;

-- Free deterministic check of the latest revision. Returns the V1 check envelope plus tradeId.
create function public.check_trade_risk(p_trade_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; latest public.trade_revisions; v_result jsonb;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  if private.trade_lifecycle(t.id) <> 'DRAFT' then
    raise exception 'DRAFT_NOT_EDITABLE: Only drafts can be checked';
  end if;
  latest := private.latest_revision(t.id);
  begin
    v_result := public.check_setup_risk(latest.proposal_id, false);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
  return v_result || jsonb_build_object('tradeId', t.id);
end $$;

-- Locks only the latest revision. The server re-evaluates regardless of any earlier check; BLOCKED returns the
-- envelope without a plan. A replay (or a lock made through check_setup_risk) returns the existing plan.
create function public.lock_trade(p_trade_id uuid, p_expected_revision int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; latest public.trade_revisions; p public.trade_plans; v_result jsonb;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  latest := private.latest_revision(t.id);
  if latest.revision is distinct from p_expected_revision then
    raise exception 'DRAFT_CHANGED: The draft changed since it was loaded (latest revision %)', coalesce(latest.revision::text, 'none');
  end if;
  select tp.* into p from public.trade_plan_links l join public.trade_plans tp on tp.id = l.plan_id where l.trade_id = t.id;
  if found then
    return jsonb_build_object('planId', p.id, 'evaluationId', p.risk_evaluation_id, 'result', p.risk_result,
                              'replayed', true, 'tradeId', t.id);
  end if;
  if private.trade_lifecycle(t.id) <> 'DRAFT' then
    raise exception 'DRAFT_NOT_EDITABLE: Only drafts can be locked';
  end if;
  begin
    v_result := public.check_setup_risk(latest.proposal_id, true);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
  -- check_setup_risk links the plan already; the link stays part of lock_trade's own contract (§3.4).
  if v_result ->> 'planId' is not null then
    insert into public.trade_plan_links(trade_id, plan_id, user_id, account_id)
      values (t.id, (v_result ->> 'planId')::uuid, t.user_id, t.account_id)
      on conflict (trade_id) do nothing;
  end if;
  return v_result || jsonb_build_object('tradeId', t.id);
end $$;

-- open_journal_trade with every V1 check. Quantity above the plan is recorded and reported (§8.5).
create function public.record_planned_entry(p_trade_id uuid, p_entry text, p_quantity text, p_entered_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; p public.trade_plans; e public.trade_executions; v_execution uuid; v_planned numeric;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  p := private.linked_plan(t);
  begin
    v_execution := public.open_journal_trade(p.id, p_entry, p_quantity, p_entered_at);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
  select * into e from public.trade_executions where id = v_execution;
  v_planned := (p.risk_result #>> '{calculations,quantity}')::numeric;
  return jsonb_build_object('executionId', e.id, 'oversize', e.quantity > v_planned,
                            'plannedQuantity', trim_scale(v_planned)::text, 'actualQuantity', trim_scale(e.quantity)::text);
end $$;

-- close_journal_trade: FULL_CLOSE_V1, R = net ÷ locked nominal risk (unchanged).
create function public.close_planned_trade(p_trade_id uuid, p_exit text, p_exited_at timestamptz, p_fees text default '0') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; p public.trade_plans; o public.trade_outcomes; v_outcome uuid;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  p := private.linked_plan(t);
  begin
    v_outcome := public.close_journal_trade(p.id, p_exit, p_exited_at, p_fees);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
  select * into o from public.trade_outcomes where id = v_outcome;
  return jsonb_build_object('tradeId', t.id, 'outcomeId', o.id, 'outcome', o.outcome, 'netPnl', trim_scale(o.net_pnl)::text,
                            'realizedR', trim_scale(o.realized_r)::text, 'calculationVersion', o.calculation_version);
end $$;

create function public.set_planned_disposition(p_trade_id uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; p public.trade_plans; d public.trade_dispositions;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  p := private.linked_plan(t);
  if p_status is null or p_status not in ('SKIPPED','CANCELLED') then
    raise exception 'INVALID_INPUT: status must be SKIPPED or CANCELLED';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 5000 then
    raise exception 'INVALID_INPUT: reason must contain 1 to 5000 characters';
  end if;
  select * into d from public.trade_dispositions where plan_id = p.id;
  if found and (d.status, d.reason) is distinct from (p_status, p_reason) then
    raise exception 'ALREADY_DISPOSED: This plan is already %', lower(d.status);
  end if;
  begin
    perform public.set_journal_disposition(p.id, p_status, p_reason);
  exception when raise_exception then
    raise exception '%', private.v1_error_message(sqlerrm);
  end;
  return jsonb_build_object('tradeId', t.id, 'status', p_status, 'lifecycle', private.trade_lifecycle(t.id));
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §2.2 Review status (the trader decides; AI review alone never marks a trade reviewed).
-- ---------------------------------------------------------------------------------------------------------
create function public.complete_trade_review(p_trade_id uuid, p_request_key uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; e public.trade_lifecycle_events; v_state text;
begin
  t := private.lock_owned_trade(p_trade_id, false);
  if p_request_key is not null then
    select * into e from public.trade_lifecycle_events where user_id = t.user_id and request_key = p_request_key;
    if found then
      if e.trade_id <> t.id or e.event <> 'REVIEW_COMPLETED' then
        raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different action';
      end if;
      return private.lifecycle_envelope(e);
    end if;
  end if;
  v_state := private.trade_lifecycle(t.id);
  if v_state = 'REVIEWED' then
    select * into e from public.trade_lifecycle_events where trade_id = t.id and event = 'REVIEW_COMPLETED'
     order by recorded_at desc, id desc limit 1;
    return private.lifecycle_envelope(e);
  end if;
  if v_state <> 'CLOSED' then raise exception 'NOT_CLOSED: Only closed trades can be marked reviewed'; end if;
  insert into public.trade_lifecycle_events(user_id, account_id, trade_id, event, request_key)
    values (t.user_id, t.account_id, t.id, 'REVIEW_COMPLETED', p_request_key) returning * into e;
  return private.lifecycle_envelope(e);
end $$;

create function public.reopen_trade_review(p_trade_id uuid, p_reason text default null, p_request_key uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.trades; e public.trade_lifecycle_events; v_state text; v_reason text := nullif(btrim(p_reason), '');
begin
  t := private.lock_owned_trade(p_trade_id, false);
  if length(v_reason) > 2000 then raise exception 'INVALID_INPUT: reason must contain at most 2000 characters'; end if;
  if p_request_key is not null then
    select * into e from public.trade_lifecycle_events where user_id = t.user_id and request_key = p_request_key;
    if found then
      if e.trade_id <> t.id or e.event <> 'REVIEW_REOPENED' or e.reason is distinct from v_reason then
        raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different action';
      end if;
      return private.lifecycle_envelope(e);
    end if;
  end if;
  v_state := private.trade_lifecycle(t.id);
  if v_state = 'CLOSED' then
    select * into e from public.trade_lifecycle_events where trade_id = t.id and event = 'REVIEW_REOPENED'
     order by recorded_at desc, id desc limit 1;
    if found then return private.lifecycle_envelope(e); end if;
  end if;
  if v_state <> 'REVIEWED' then raise exception 'NOT_REVIEWED: Only reviewed trades can be reopened'; end if;
  insert into public.trade_lifecycle_events(user_id, account_id, trade_id, event, reason, request_key)
    values (t.user_id, t.account_id, t.id, 'REVIEW_REOPENED', v_reason, p_request_key) returning * into e;
  return private.lifecycle_envelope(e);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.5 Live-first trades. Input fields: instrumentId?, symbol?, direction, entryModel?, entryPrice?,
-- enteredAt? (ISO 8601 with zone; absent = unknown), quantity?, initialStop?, riskAmount? (money).
-- ---------------------------------------------------------------------------------------------------------
create function public.record_live_trade(p_account_id uuid, p_input jsonb, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.accounts; t public.trades; first_row public.trade_position_facts; v public.trade_position_facts; v_trade uuid;
begin
  a := private.lock_owned_account(p_account_id);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  perform private.require_object(p_input,
    array['instrumentId','symbol','direction','entryModel','entryPrice','enteredAt','quantity','initialStop','riskAmount'], 'live trade');
  v := private.position_input(a, p_input);
  select * into t from public.trades where user_id = a.user_id and request_key = p_request_key;
  if found then
    select * into first_row from public.trade_position_facts where trade_id = t.id order by recorded_at, id limit 1;
    if t.account_id <> a.id or t.origin <> 'LIVE_FIRST'
       or (first_row.instrument_version_id, first_row.symbol, first_row.direction, first_row.entry_model, first_row.entry_price,
           first_row.entered_at, first_row.quantity, first_row.initial_stop, first_row.risk_amount)
          is distinct from (v.instrument_version_id, v.symbol, v.direction, v.entry_model, v.entry_price,
           v.entered_at, v.quantity, v.initial_stop, v.risk_amount) then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different trade';
    end if;
    return t.id;
  end if;
  if v.symbol is null or v.direction is null then
    raise exception 'INVALID_INPUT: An instrument (or symbol) and a direction are required';
  end if;
  perform private.check_position(v, clock_timestamp());
  insert into public.trades(user_id, account_id, origin, request_key)
    values (a.user_id, a.id, 'LIVE_FIRST', p_request_key) returning id into v_trade;
  insert into public.trade_position_facts(user_id, account_id, trade_id, instrument_version_id, symbol, direction, entry_model,
      entry_price, entered_at, quantity, initial_stop, risk_amount, source, request_key)
    values (a.user_id, a.id, v_trade, v.instrument_version_id, v.symbol, v.direction, v.entry_model,
      v.entry_price, v.entered_at, v.quantity, v.initial_stop, v.risk_amount, 'USER', p_request_key);
  return v_trade;
end $$;

-- Fills entry facts that are still unknown, once each; a recorded fact is never changed. Returns the facts row id.
create function public.complete_live_entry(p_trade_id uuid, p_input jsonb, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades; a public.accounts; existing public.trade_position_facts;
  cur public.trade_position_facts; v public.trade_position_facts; merged public.trade_position_facts; v_id uuid;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  if t.origin = 'PLANNED' then
    raise exception 'ORIGIN_MISMATCH: Planned trades record their entry through the locked plan';
  end if;
  perform private.require_object(p_input,
    array['instrumentId','entryModel','entryPrice','enteredAt','quantity','initialStop','riskAmount'], 'entry details');
  select * into a from public.accounts where id = t.account_id;
  v := private.position_input(a, p_input);
  select * into existing from public.trade_position_facts where user_id = t.user_id and request_key = p_request_key;
  if found then
    if existing.trade_id <> t.id
       or (existing.instrument_version_id, existing.entry_model, existing.entry_price, existing.entered_at, existing.quantity,
           existing.initial_stop, existing.risk_amount)
          is distinct from (v.instrument_version_id, v.entry_model, v.entry_price, v.entered_at, v.quantity,
           v.initial_stop, v.risk_amount) then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for different entry details';
    end if;
    return existing.id;
  end if;
  if exists (select 1 from public.trade_unplanned_closes c where c.trade_id = t.id) then
    raise exception 'ALREADY_CLOSED: Entry details of a closed trade are immutable';
  end if;
  if num_nonnulls(v.instrument_version_id, v.entry_model, v.entry_price, v.entered_at, v.quantity, v.initial_stop, v.risk_amount) = 0 then
    raise exception 'INVALID_INPUT: Provide at least one missing entry detail';
  end if;
  cur := private.effective_position(t.id);
  if (v.instrument_version_id is not null and cur.instrument_version_id is not null)
     or (v.entry_model is not null and cur.entry_model is not null)
     or (v.entry_price is not null and cur.entry_price is not null)
     or (v.entered_at is not null and cur.entered_at is not null)
     or (v.quantity is not null and cur.quantity is not null)
     or (v.initial_stop is not null and cur.initial_stop is not null)
     or (v.risk_amount is not null and cur.risk_amount is not null) then
    raise exception 'ENTRY_DETAILS_IMMUTABLE: Recorded entry details cannot be changed';
  end if;
  if v.instrument_version_id is not null and v.symbol <> cur.symbol then
    raise exception 'INVALID_INPUT: The instrument does not match the recorded symbol %', cur.symbol;
  end if;
  merged := cur;
  merged.instrument_version_id := coalesce(cur.instrument_version_id, v.instrument_version_id);
  merged.entry_model := coalesce(cur.entry_model, v.entry_model);
  merged.entry_price := coalesce(cur.entry_price, v.entry_price);
  merged.entered_at := coalesce(cur.entered_at, v.entered_at);
  merged.quantity := coalesce(cur.quantity, v.quantity);
  merged.initial_stop := coalesce(cur.initial_stop, v.initial_stop);
  merged.risk_amount := coalesce(cur.risk_amount, v.risk_amount);
  perform private.check_position(merged, t.created_at);
  insert into public.trade_position_facts(user_id, account_id, trade_id, instrument_version_id, entry_model, entry_price,
      entered_at, quantity, initial_stop, risk_amount, source, request_key)
    values (t.user_id, t.account_id, t.id, v.instrument_version_id, v.entry_model, v.entry_price,
      v.entered_at, v.quantity, v.initial_stop, v.risk_amount, 'USER', p_request_key)
    returning id into v_id;
  return v_id;
end $$;

-- UNPLANNED_CLOSE_V1. Input {exitPrice?, exitedAt, fees? (default 0), netPnl? (signed money)}.
-- Calculable (contract, entry, size and exit known): gross = (exit − entry) × dir × tick value × qty ÷ tick size,
-- and a reported net P&L is rejected. Otherwise the reported net P&L is required. Risk basis: reported risk amount,
-- else |entry − stop| × tick value × qty ÷ tick size when all are known, else none (realized R stays null).
-- Returns the trade id; an exact replay returns it again, different values raise ALREADY_CLOSED.
create function public.close_live_trade(p_trade_id uuid, p_input jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades; c public.trade_unplanned_closes; pos public.trade_position_facts; i public.instrument_versions;
  v_exit numeric; v_exited timestamptz; v_fees numeric; v_reported numeric;
  v_gross numeric; v_net numeric; v_source text; v_basis numeric; v_basis_source text; v_r numeric;
begin
  t := private.lock_owned_trade(p_trade_id, true);
  if t.origin = 'PLANNED' then
    raise exception 'ORIGIN_MISMATCH: Planned trades are closed through their locked plan';
  end if;
  perform private.require_object(p_input, array['exitPrice','exitedAt','fees','netPnl'], 'close');
  v_exit := private.decimal_input(private.json_text(p_input, 'exitPrice'), 'exitPrice');
  v_exited := private.instant_input(private.json_text(p_input, 'exitedAt'), 'exitedAt');
  if v_exited is null then raise exception 'INVALID_INPUT: exitedAt is required'; end if;
  v_fees := coalesce(private.money_input(private.json_text(p_input, 'fees'), 'fees', true), 0);
  v_reported := private.signed_money_input(private.json_text(p_input, 'netPnl'), 'netPnl');
  select * into c from public.trade_unplanned_closes where trade_id = t.id;
  if found then
    if c.exit_price is not distinct from v_exit and c.exited_at = v_exited and c.fees = v_fees
       and ((c.pnl_source = 'CALCULATED' and v_reported is null) or (c.pnl_source <> 'CALCULATED' and c.net_pnl = v_reported)) then
      return c.trade_id;
    end if;
    raise exception 'ALREADY_CLOSED: The trade is already closed with different values';
  end if;
  pos := private.effective_position(t.id);
  if v_exited > clock_timestamp() then raise exception 'INVALID_TIME: The exit time must not be in the future'; end if;
  if v_exited < pos.entered_at then raise exception 'INVALID_TIME: The exit time must not be before the entry time'; end if;
  select * into i from public.instrument_versions where id = pos.instrument_version_id;
  if i.id is not null and pos.entry_price is not null and pos.quantity is not null and v_exit is not null then
    if v_reported is not null then
      raise exception 'PNL_IS_CALCULATED: Net P&L is calculated from the recorded prices and size';
    end if;
    v_gross := trim_scale((v_exit - pos.entry_price) * case when pos.direction = 'LONG' then 1 else -1 end
                          * i.tick_value * pos.quantity / i.tick_size);
    v_net := v_gross - v_fees;
    v_source := 'CALCULATED';
  else
    if v_reported is null then
      raise exception 'PNL_REQUIRED: Report the net P&L; it cannot be calculated from the recorded facts';
    end if;
    v_net := v_reported;
    v_source := 'USER_REPORTED';
  end if;
  if pos.risk_amount is not null then
    v_basis := trim_scale(pos.risk_amount);
    v_basis_source := 'USER_REPORTED';
  elsif i.id is not null and pos.entry_price is not null and pos.initial_stop is not null and pos.quantity is not null then
    v_basis := trim_scale(abs(pos.entry_price - pos.initial_stop) * i.tick_value * pos.quantity / i.tick_size);
    v_basis_source := 'DERIVED';
  end if;
  if v_basis is not null then v_r := trim_scale(v_net / v_basis); end if;
  insert into public.trade_unplanned_closes(trade_id, user_id, account_id, exit_price, exited_at, fees, gross_pnl, net_pnl,
      pnl_source, risk_basis, risk_basis_source, realized_r, outcome)
    values (t.id, t.user_id, t.account_id, v_exit, v_exited, v_fees, v_gross, trim_scale(v_net),
      v_source, v_basis, v_basis_source, v_r, case when v_net > 0 then 'WIN' when v_net < 0 then 'LOSS' else 'BREAKEVEN' end);
  return t.id;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.6 Journal entry. Phase and state are computed at insert time from server-side facts (§5.2).
-- ---------------------------------------------------------------------------------------------------------
create function public.add_journal_entry(p_trade_id uuid, p_kind text, p_body text, p_details jsonb, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades; e public.trade_journal_entries; v_id uuid;
  v_body text := nullif(btrim(p_body, E' \t\r\n'), '');
  v_details jsonb := case when jsonb_typeof(p_details) = 'object' then jsonb_strip_nulls(p_details) else p_details end;
begin
  t := private.lock_owned_trade(p_trade_id, false);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  v_details := coalesce(v_details, '{}'::jsonb);
  select * into e from public.trade_journal_entries where user_id = t.user_id and request_key = p_request_key;
  if found then
    if e.trade_id <> t.id or e.kind is distinct from p_kind or e.body is distinct from v_body or e.details <> v_details then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different entry';
    end if;
    return e.id;
  end if;
  if length(v_body) > 5000 then raise exception 'INVALID_INPUT: body must contain at most 5000 characters'; end if;
  if jsonb_typeof(v_details) <> 'object' then raise exception 'INVALID_INPUT: details must be a JSON object'; end if;
  perform private.check_journal_details(p_kind, v_body, v_details, (private.trade_instrument(t)).tick_size);
  insert into public.trade_journal_entries(user_id, account_id, trade_id, kind, body, details, phase, state_at_creation, request_key)
    values (t.user_id, t.account_id, t.id, p_kind, v_body, v_details, private.trade_phase(t.id), private.trade_lifecycle(t.id), p_request_key)
    returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.7 Evidence RPCs. register_trade_evidence is called only by the trusted upload route after byte validation
-- and the storage upload; p_user_id comes from the verified session and is re-checked against the trade.
-- p_record: {id, tradeId, storagePath?, label, timeframe?, caption?, originalFilename, mimeType, byteSize, sha256,
-- width, height, captureMethod, copiedFrom?}. Returns {id, tradeId, phase, stateAtCreation, recordedAt, replayed}.
-- ---------------------------------------------------------------------------------------------------------
-- §7.4: a duplicated draft may copy only evidence that was Before entry in its source trade: active, same content,
-- V2 evidence stored PRE_ENTRY, and (when the source has an entry) recorded before the entry time. Legacy
-- screenshots belong to the source through its revisions. Live and after-close evidence is never copyable, because
-- it would become pre-entry evidence of the copy.
create function private.copyable_evidence(p_source_trade uuid, p_evidence_id uuid, p_sha256 text) returns boolean
language sql stable security definer set search_path = '' as $$
  with source_entry as (
    select e.entered_at from public.trade_plan_links l join public.trade_executions e on e.plan_id = l.plan_id
     where l.trade_id = p_source_trade
  )
  select exists (
           select 1 from public.trade_evidence x
            where x.id = p_evidence_id and x.trade_id = p_source_trade and x.sha256 = p_sha256 and x.phase = 'PRE_ENTRY'
              and not exists (select 1 from public.trade_evidence_removals r where r.evidence_id = x.id)
              and not exists (select 1 from source_entry s where x.recorded_at >= s.entered_at))
      or exists (
           select 1 from public.setup_screenshots s join public.trade_revisions r on r.proposal_id = s.proposal_id
            where s.id = p_evidence_id and r.trade_id = p_source_trade and s.sha256 = p_sha256
              and not exists (select 1 from public.setup_screenshot_removals x where x.screenshot_id = s.id)
              and not exists (select 1 from source_entry e where s.uploaded_at >= e.entered_at))
$$;

create function public.register_trade_evidence(p_user_id uuid, p_record jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.trades; e public.trade_evidence; v_id uuid; v_trade uuid; v_path text; v_label text; v_timeframe text; v_caption text;
  v_filename text; v_mime text; v_size bigint; v_sha text; v_width bigint; v_height bigint; v_capture text; v_copied uuid;
begin
  perform private.require_object(p_record, array['id','tradeId','storagePath','label','timeframe','caption','originalFilename',
    'mimeType','byteSize','sha256','width','height','captureMethod','copiedFrom'], 'evidence');
  v_id := private.uuid_input(private.json_text(p_record, 'id'), 'id');
  v_trade := private.uuid_input(private.json_text(p_record, 'tradeId'), 'tradeId');
  if p_user_id is null or v_id is null or v_trade is null then
    raise exception 'INVALID_INPUT: user, id and tradeId are required';
  end if;
  select * into t from public.trades where id = v_trade and user_id = p_user_id for update;
  if not found then raise exception 'TRADE_NOT_FOUND: Trade not found'; end if;
  v_path := p_user_id::text || '/' || t.id::text || '/' || v_id::text;
  if private.json_text(p_record, 'storagePath') is distinct from v_path and p_record ? 'storagePath' then
    raise exception 'INVALID_INPUT: storagePath must be %', v_path;
  end if;
  v_label := private.json_text(p_record, 'label');
  if v_label is null or v_label not in ('HTF','CONTEXT','PRE_ENTRY','ENTRY','MANAGEMENT','EXIT','OTHER') then
    raise exception 'INVALID_INPUT: label must be HTF, CONTEXT, PRE_ENTRY, ENTRY, MANAGEMENT, EXIT or OTHER';
  end if;
  v_timeframe := private.json_text(p_record, 'timeframe');
  if v_timeframe not in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER') then
    raise exception 'INVALID_INPUT: timeframe must be DAILY, H4, H1, M30, M15, M5, M3 or OTHER';
  end if;
  v_caption := nullif(btrim(private.json_text(p_record, 'caption')), '');
  if length(v_caption) > 200 then raise exception 'INVALID_INPUT: caption must contain at most 200 characters'; end if;
  v_filename := private.json_text(p_record, 'originalFilename');
  if v_filename is null or length(v_filename) not between 1 and 255 then
    raise exception 'INVALID_INPUT: originalFilename must contain 1 to 255 characters';
  end if;
  v_mime := private.json_text(p_record, 'mimeType');
  if v_mime is null or v_mime not in ('image/png','image/jpeg','image/webp') then
    raise exception 'INVALID_INPUT: mimeType must be image/png, image/jpeg or image/webp';
  end if;
  v_size := private.integer_input(p_record, 'byteSize', 1, 4194304);
  v_width := private.integer_input(p_record, 'width', 1, 2147483647);
  v_height := private.integer_input(p_record, 'height', 1, 2147483647);
  if v_size is null or v_width is null or v_height is null then
    raise exception 'INVALID_INPUT: byteSize, width and height are required';
  end if;
  if v_width * v_height > 40000000 then raise exception 'INVALID_INPUT: images are limited to 40 megapixels'; end if;
  v_sha := private.json_text(p_record, 'sha256');
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT: sha256 must be 64 lowercase hex characters'; end if;
  v_capture := private.json_text(p_record, 'captureMethod');
  if v_capture is null or v_capture not in ('PASTE','DROP','FILE','CAMERA','DUPLICATE','IMPORT') then
    raise exception 'INVALID_INPUT: captureMethod must be PASTE, DROP, FILE, CAMERA, DUPLICATE or IMPORT';
  end if;
  v_copied := private.uuid_input(private.json_text(p_record, 'copiedFrom'), 'copiedFrom');
  select * into e from public.trade_evidence where id = v_id;
  if found then
    if e.user_id = p_user_id and e.trade_id = t.id and e.sha256 = v_sha then
      return jsonb_build_object('id', e.id, 'tradeId', e.trade_id, 'phase', e.phase, 'stateAtCreation', e.state_at_creation,
                                'recordedAt', e.recorded_at, 'replayed', true);
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT: This evidence id is already registered with different content';
  end if;
  if v_capture = 'DUPLICATE' then
    if v_copied is null or t.duplicated_from is null or not private.copyable_evidence(t.duplicated_from, v_copied, v_sha) then
      raise exception 'INVALID_INPUT: copiedFrom must reference active pre-entry evidence with the same content on the trade this draft was duplicated from';
    end if;
  elsif v_copied is not null then
    raise exception 'INVALID_INPUT: copiedFrom is only valid for duplicated evidence';
  end if;
  if (select count(*) from public.trade_evidence x
       where x.trade_id = t.id and not exists (select 1 from public.trade_evidence_removals r where r.evidence_id = x.id)) >= 24 then
    raise exception 'EVIDENCE_LIMIT: A trade supports 24 active screenshots. Remove one before adding another.';
  end if;
  insert into public.trade_evidence(id, user_id, account_id, trade_id, storage_path, label, timeframe, caption, original_filename,
      mime_type, byte_size, sha256, width, height, phase, state_at_creation, capture_method, copied_from)
    values (v_id, t.user_id, t.account_id, t.id, v_path, v_label, v_timeframe, v_caption, v_filename,
      v_mime, v_size, v_sha, v_width, v_height, private.trade_phase(t.id), private.trade_lifecycle(t.id), v_capture, v_copied)
    returning * into e;
  return jsonb_build_object('id', e.id, 'tradeId', e.trade_id, 'phase', e.phase, 'stateAtCreation', e.state_at_creation,
                            'recordedAt', e.recorded_at, 'replayed', false);
end $$;

-- §2.5: evidence can be removed and relabelled in every lifecycle state. Both are appended (soft and audited); the
-- evidence row, its phase, state at creation and recorded time never change, so timing cannot be rewritten.
-- Removal is idempotent and removed evidence cannot be relabelled.
create function public.remove_trade_evidence(p_evidence_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.trade_evidence;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into e from public.trade_evidence where id = p_evidence_id and user_id = auth.uid();
  if not found then raise exception 'EVIDENCE_NOT_FOUND: Evidence not found'; end if;
  perform 1 from public.trades where id = e.trade_id for update;
  if exists (select 1 from public.trade_evidence_removals r where r.evidence_id = e.id) then return; end if;
  insert into public.trade_evidence_removals(evidence_id, user_id, account_id, trade_id)
    values (e.id, e.user_id, e.account_id, e.trade_id);
end $$;

-- The latest label row wins. Unchanged input is a no-op.
create function public.relabel_trade_evidence(p_evidence_id uuid, p_label text, p_timeframe text, p_caption text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.trade_evidence; cur_label text; cur_timeframe text; cur_caption text; v_caption text := nullif(btrim(p_caption), '');
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into e from public.trade_evidence where id = p_evidence_id and user_id = auth.uid();
  if not found then raise exception 'EVIDENCE_NOT_FOUND: Evidence not found'; end if;
  perform 1 from public.trades where id = e.trade_id for update;
  if exists (select 1 from public.trade_evidence_removals r where r.evidence_id = e.id) then
    raise exception 'EVIDENCE_REMOVED: Removed evidence cannot be relabelled';
  end if;
  if p_label is null or p_label not in ('HTF','CONTEXT','PRE_ENTRY','ENTRY','MANAGEMENT','EXIT','OTHER') then
    raise exception 'INVALID_INPUT: label must be HTF, CONTEXT, PRE_ENTRY, ENTRY, MANAGEMENT, EXIT or OTHER';
  end if;
  if p_timeframe not in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER') then
    raise exception 'INVALID_INPUT: timeframe must be DAILY, H4, H1, M30, M15, M5, M3 or OTHER';
  end if;
  if length(v_caption) > 200 then raise exception 'INVALID_INPUT: caption must contain at most 200 characters'; end if;
  select l.label, l.timeframe, l.caption into cur_label, cur_timeframe, cur_caption
    from public.trade_evidence_labels l where l.evidence_id = e.id order by l.id desc limit 1;
  if not found then
    cur_label := e.label;
    cur_timeframe := e.timeframe;
    cur_caption := e.caption;
  end if;
  if (cur_label, cur_timeframe, cur_caption) is not distinct from (p_label, p_timeframe, v_caption) then return; end if;
  insert into public.trade_evidence_labels(evidence_id, user_id, account_id, trade_id, label, timeframe, caption)
    values (e.id, e.user_id, e.account_id, e.trade_id, p_label, p_timeframe, v_caption);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.8 Tags. The latest set wins; identical input returns the current set id.
-- ---------------------------------------------------------------------------------------------------------
create function public.set_trade_tags(p_trade_id uuid, p_grade text, p_liquidity text, p_mss text, p_tags text[]) returns bigint
language plpgsql security definer set search_path = '' as $$
declare t public.trades; cur public.trade_tag_sets; v_tags text[] := coalesce(p_tags, '{}'::text[]); v_id bigint;
begin
  t := private.lock_owned_trade(p_trade_id, false);
  if p_grade not in ('A+','A','B','C','INVALID') then raise exception 'INVALID_INPUT: grade must be A+, A, B, C or INVALID'; end if;
  if p_liquidity not in ('ARL_HIGH','ARL_LOW','PDH','PDL','PWH','PWL','KZ_HIGH','KZ_LOW','EQUAL_HIGHS','EQUAL_LOWS','OTHER') then
    raise exception 'INVALID_INPUT: liquidity context is not recognised';
  end if;
  if p_mss not in ('M15','M5','M3') then raise exception 'INVALID_INPUT: MSS timeframe must be M15, M5 or M3'; end if;
  if not private.valid_tags(v_tags) then
    raise exception 'INVALID_INPUT: Use at most 12 unique tags of 1 to 32 characters (a-z, 0-9, space, "_" or "-"), starting with a letter or digit';
  end if;
  select * into cur from public.trade_tag_sets where trade_id = t.id order by id desc limit 1;
  if found and (cur.setup_grade, cur.liquidity_context, cur.mss_timeframe, cur.tags)
               is not distinct from (p_grade, p_liquidity, p_mss, v_tags) then
    return cur.id;
  end if;
  insert into public.trade_tag_sets(user_id, account_id, trade_id, setup_grade, liquidity_context, mss_timeframe, tags)
    values (t.user_id, t.account_id, t.id, p_grade, p_liquidity, p_mss, v_tags) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.9 External losses, dated to the strategy day at recording.
-- ---------------------------------------------------------------------------------------------------------
create function public.add_external_loss(p_account_id uuid, p_amount text, p_note text, p_request_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.accounts; e public.external_loss_entries; v_amount numeric; v_note text := nullif(btrim(p_note), ''); v_id uuid;
begin
  a := private.lock_owned_account(p_account_id);
  if p_request_key is null then raise exception 'INVALID_INPUT: A request key is required'; end if;
  v_amount := private.money_input(p_amount, 'amount');
  if v_amount is null then raise exception 'INVALID_INPUT: amount is required'; end if;
  if length(v_note) > 500 then raise exception 'INVALID_INPUT: note must contain at most 500 characters'; end if;
  select * into e from public.external_loss_entries where user_id = a.user_id and request_key = p_request_key;
  if found then
    if e.account_id <> a.id or e.amount <> v_amount or e.note is distinct from v_note then
      raise exception 'IDEMPOTENCY_CONFLICT: This request key was already used for a different loss';
    end if;
    return e.id;
  end if;
  insert into public.external_loss_entries(user_id, account_id, trading_day, amount, note, request_key)
    values (a.user_id, a.id, private.strategy_day(clock_timestamp()), v_amount, v_note, p_request_key) returning id into v_id;
  return v_id;
end $$;

create function public.remove_external_loss(p_entry_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.external_loss_entries; v_reason text := nullif(btrim(p_reason), '');
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Authentication required'; end if;
  select * into e from public.external_loss_entries where id = p_entry_id and user_id = auth.uid();
  if not found then raise exception 'EXTERNAL_LOSS_NOT_FOUND: External loss not found'; end if;
  perform private.lock_owned_account(e.account_id);
  if length(v_reason) > 500 then raise exception 'INVALID_INPUT: reason must contain at most 500 characters'; end if;
  insert into public.external_loss_removals(entry_id, user_id, account_id, reason)
    values (e.id, e.user_id, e.account_id, v_reason) on conflict (entry_id) do nothing;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.10 Risk policy v2: create_risk_version semantics plus the required default risk (≤ maximum).
-- p_config {maxRiskPercent, defaultRiskPercent, maxDailyTrades, minRR, rrPolicy, newsPolicy, dailyRiskCap?, dailyLossCap?}.
-- ---------------------------------------------------------------------------------------------------------
create function public.create_risk_policy_version(p_account_id uuid, p_config jsonb, p_immediate boolean, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.accounts; v_immediate boolean := coalesce(p_immediate, false); v_reason text := nullif(btrim(p_reason), '');
  v_max numeric; v_default numeric; v_trades bigint; v_min_rr numeric; v_rr_policy text; v_news_policy text;
  v_risk_cap numeric; v_loss_cap numeric; v_day date; v_count int; v_id uuid;
begin
  a := private.lock_owned_account(p_account_id);
  perform private.require_object(p_config, array['maxRiskPercent','defaultRiskPercent','maxDailyTrades','minRR','rrPolicy',
    'newsPolicy','dailyRiskCap','dailyLossCap'], 'risk policy');
  v_max := private.decimal_input(private.json_text(p_config, 'maxRiskPercent'), 'maxRiskPercent');
  v_default := private.decimal_input(private.json_text(p_config, 'defaultRiskPercent'), 'defaultRiskPercent');
  v_trades := private.integer_input(p_config, 'maxDailyTrades', 1, 100);
  v_min_rr := private.decimal_input(private.json_text(p_config, 'minRR'), 'minRR');
  v_rr_policy := private.json_text(p_config, 'rrPolicy');
  v_news_policy := private.json_text(p_config, 'newsPolicy');
  v_risk_cap := private.money_input(private.json_text(p_config, 'dailyRiskCap'), 'dailyRiskCap');
  v_loss_cap := private.money_input(private.json_text(p_config, 'dailyLossCap'), 'dailyLossCap');
  if v_max is null or v_default is null or v_trades is null or v_min_rr is null then
    raise exception 'INVALID_INPUT: maxRiskPercent, defaultRiskPercent, maxDailyTrades and minRR are required';
  end if;
  if v_max > 100 then raise exception 'INVALID_INPUT: maxRiskPercent must not exceed 100'; end if;
  if v_default > v_max then raise exception 'INVALID_INPUT: defaultRiskPercent must not exceed maxRiskPercent'; end if;
  if v_min_rr > 100 then raise exception 'INVALID_INPUT: minRR must not exceed 100'; end if;
  if v_rr_policy is null or v_rr_policy not in ('BLOCK','WARN') then raise exception 'INVALID_INPUT: rrPolicy must be BLOCK or WARN'; end if;
  if v_news_policy is null or v_news_policy not in ('BLOCK','WARN') then raise exception 'INVALID_INPUT: newsPolicy must be BLOCK or WARN'; end if;
  if v_immediate and (v_reason is null or length(v_reason) < 5) then
    raise exception 'REASON_REQUIRED: An immediate change requires a reason of at least 5 characters';
  end if;
  v_day := private.strategy_day(clock_timestamp()) + case when v_immediate then 0 else 1 end;
  select count(*) into v_count from public.risk_plan_versions where account_id = a.id;
  insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
      max_daily_trades, min_rr, rr_policy, news_policy, daily_risk_cap, daily_loss_cap, override_reason)
    values (a.user_id, a.id, 'Risk Plan V1.' || v_count, v_day, v_max, v_default, v_trades, v_min_rr, v_rr_policy, v_news_policy,
      v_risk_cap, v_loss_cap, case when v_immediate then v_reason end)
    returning id into v_id;
  insert into public.configuration_events(user_id, account_id, event_type, payload)
    values (a.user_id, a.id, 'RISK_VERSION_CREATED', jsonb_build_object('version_id', v_id, 'effective_day', v_day,
      'immediate', v_immediate, 'reason', case when v_immediate then v_reason end, 'default_risk_percent', v_default::text));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- §3.11 Schema marker read by the app's schema gate.
-- ---------------------------------------------------------------------------------------------------------
create function public.trading_os_schema() returns text
language sql stable security invoker set search_path = '' as $$ select '2.0'::text $$;

-- ---------------------------------------------------------------------------------------------------------
-- Function privileges: explicit revoke per signature, then the exact grant.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  private.seed_ict_strategy(uuid, uuid), private.supported_currencies(), private.valid_tags(text[]),
  private.require_object(jsonb, text[], text), private.json_text(jsonb, text), private.integer_input(jsonb, text, bigint, bigint),
  private.uuid_input(text, text), private.decimal_input(text, text), private.money_input(text, text, boolean),
  private.signed_money_input(text, text), private.instant_input(text, text), private.v1_error_message(text),
  private.lock_owned_account(uuid), private.lock_owned_trade(uuid, boolean), private.latest_revision(uuid),
  private.linked_plan(public.trades), private.trade_lifecycle(uuid), private.trade_phase(uuid), private.effective_position(uuid),
  private.guard_position_facts(), private.trade_instrument(public.trades), private.check_draft_proposal(uuid, jsonb),
  private.save_draft_proposal(uuid, jsonb, uuid, uuid, uuid), private.draft_envelope(uuid, public.setup_proposals, integer),
  private.lifecycle_envelope(public.trade_lifecycle_events), private.position_input(public.accounts, jsonb),
  private.check_position(public.trade_position_facts, timestamptz), private.check_journal_details(text, text, jsonb, numeric),
  private.active_risk_plan(uuid, date), private.check_proposal_risk(uuid, boolean), private.copyable_evidence(uuid, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.create_trading_account(uuid, jsonb), public.update_account_profile(uuid, jsonb),
  public.create_instrument_version(uuid, jsonb), public.record_account_values(uuid, text, text),
  public.create_planned_trade(uuid, jsonb, uuid, uuid, uuid), public.revise_trade_draft(uuid, jsonb, uuid, integer, uuid, uuid),
  public.duplicate_trade_draft(uuid, uuid, uuid, uuid), public.discard_trade_draft(uuid, text, uuid),
  public.check_trade_risk(uuid), public.lock_trade(uuid, integer),
  public.record_planned_entry(uuid, text, text, timestamptz), public.close_planned_trade(uuid, text, timestamptz, text),
  public.set_planned_disposition(uuid, text, text), public.complete_trade_review(uuid, uuid),
  public.reopen_trade_review(uuid, text, uuid), public.record_live_trade(uuid, jsonb, uuid),
  public.complete_live_entry(uuid, jsonb, uuid), public.close_live_trade(uuid, jsonb),
  public.add_journal_entry(uuid, text, text, jsonb, uuid), public.remove_trade_evidence(uuid),
  public.relabel_trade_evidence(uuid, text, text, text), public.set_trade_tags(uuid, text, text, text, text[]),
  public.add_external_loss(uuid, text, text, uuid), public.remove_external_loss(uuid, text),
  public.create_risk_policy_version(uuid, jsonb, boolean, text), public.trading_os_schema()
  from public, anon, service_role;
grant execute on function
  public.create_trading_account(uuid, jsonb), public.update_account_profile(uuid, jsonb),
  public.create_instrument_version(uuid, jsonb), public.record_account_values(uuid, text, text),
  public.create_planned_trade(uuid, jsonb, uuid, uuid, uuid), public.revise_trade_draft(uuid, jsonb, uuid, integer, uuid, uuid),
  public.duplicate_trade_draft(uuid, uuid, uuid, uuid), public.discard_trade_draft(uuid, text, uuid),
  public.check_trade_risk(uuid), public.lock_trade(uuid, integer),
  public.record_planned_entry(uuid, text, text, timestamptz), public.close_planned_trade(uuid, text, timestamptz, text),
  public.set_planned_disposition(uuid, text, text), public.complete_trade_review(uuid, uuid),
  public.reopen_trade_review(uuid, text, uuid), public.record_live_trade(uuid, jsonb, uuid),
  public.complete_live_entry(uuid, jsonb, uuid), public.close_live_trade(uuid, jsonb),
  public.add_journal_entry(uuid, text, text, jsonb, uuid), public.remove_trade_evidence(uuid),
  public.relabel_trade_evidence(uuid, text, text, text), public.set_trade_tags(uuid, text, text, text, text[]),
  public.add_external_loss(uuid, text, text, uuid), public.remove_external_loss(uuid, text),
  public.create_risk_policy_version(uuid, jsonb, boolean, text), public.trading_os_schema()
  to authenticated;

revoke all on function public.register_trade_evidence(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.register_trade_evidence(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
