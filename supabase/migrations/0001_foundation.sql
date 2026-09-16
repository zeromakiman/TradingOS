-- Trading OS: immutable, tenant-isolated deterministic foundation.
create schema if not exists private;
revoke all on schema private from public;

create table public.accounts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
  name text not null check(length(name) between 1 and 100), currency text not null check(currency = 'USD'),
  mode text not null default 'DEMO' check(mode = 'DEMO'), created_at timestamptz not null default clock_timestamp(),
  unique(user_id,id)
);
create table public.account_observations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  equity numeric(20,2) not null check(equity > 0 and equity < 1000000000000),
  balance numeric(20,2) not null check(balance > 0 and balance < 1000000000000),
  gross_loss_today numeric(20,2) check(gross_loss_today >= 0 and gross_loss_today < 1000000000000),
  trading_day date not null, source text not null default 'USER_REPORTED' check(source = 'USER_REPORTED'),
  recorded_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,id),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.strategy_versions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  version text not null, schema_version int not null default 1, rules jsonb not null check(jsonb_typeof(rules) = 'object'),
  written_rules text not null, created_at timestamptz not null default clock_timestamp(),
  unique(user_id,account_id,id), unique(account_id,version),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.risk_plan_versions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  version text not null, schema_version int not null default 1, effective_day date not null,
  max_risk_percent numeric(11,8) not null check(max_risk_percent > 0 and max_risk_percent <= 100),
  max_daily_trades int not null check(max_daily_trades between 1 and 100),
  min_rr numeric(12,8) not null check(min_rr > 0 and min_rr <= 100),
  rr_policy text not null check(rr_policy in ('BLOCK','WARN')),
  news_policy text not null check(news_policy in ('BLOCK','WARN')),
  daily_risk_cap numeric(20,2) check(daily_risk_cap > 0 and daily_risk_cap < 1000000000000),
  daily_loss_cap numeric(20,2) check(daily_loss_cap > 0 and daily_loss_cap < 1000000000000),
  override_reason text, created_at timestamptz not null default clock_timestamp(),
  unique(user_id,account_id,id), unique(account_id,version),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.instrument_versions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  symbol text not null, currency text not null check(currency = 'USD'), quantity_unit text not null,
  tick_size numeric(20,8) not null check(tick_size > 0 and tick_size < 1000000000000),
  pip_size numeric(20,8) check(pip_size > 0 and pip_size < 1000000000000),
  tick_value numeric(20,8) not null check(tick_value > 0 and tick_value < 1000000000000),
  quantity_step numeric(20,8) not null check(quantity_step > 0 and quantity_step < 1000000000000),
  minimum_quantity numeric(20,8) not null check(minimum_quantity > 0 and minimum_quantity < 1000000000000),
  source text not null default 'STANDARD_CONTRACT_REQUIRES_CONFIRMATION',
  created_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,id),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.risk_evaluations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  proposal jsonb not null, result jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
  unique(user_id,account_id,id), foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.trade_plans (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  strategy_version_id uuid not null, risk_plan_version_id uuid not null, instrument_version_id uuid not null,
  account_observation_id uuid not null, risk_evaluation_id uuid not null,
  idempotency_key uuid not null, proposal jsonb not null, risk_result jsonb not null,
  setup_status text not null default 'NOT_EVALUATED' check(setup_status = 'NOT_EVALUATED'),
  nominal_risk numeric not null check(nominal_risk > 0), trading_day date not null,
  locked_at timestamptz not null default clock_timestamp(), schema_version int not null default 1,
  unique(user_id,account_id,id), unique(account_id,idempotency_key),
  foreign key(user_id,account_id) references public.accounts(user_id,id),
  foreign key(user_id,account_id,strategy_version_id) references public.strategy_versions(user_id,account_id,id),
  foreign key(user_id,account_id,risk_plan_version_id) references public.risk_plan_versions(user_id,account_id,id),
  foreign key(user_id,account_id,instrument_version_id) references public.instrument_versions(user_id,account_id,id),
  foreign key(user_id,account_id,account_observation_id) references public.account_observations(user_id,account_id,id),
  foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id)
);
create index trade_plans_account_day on public.trade_plans(account_id,trading_day);
create table public.trade_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, plan_id uuid not null,
  sequence bigint generated always as identity, event_type text not null check(event_type in ('PLAN_LOCKED','NOTE_ADDED','STOP_MOVED','TARGET_CHANGED','PARTIAL_CLOSED','SL_TO_BE','TRADE_OPENED','TRADE_CLOSED','POSITION_ADDED','MANUAL_OVERRIDE','PLAN_CANCELLED')),
  payload jsonb not null check(jsonb_typeof(payload) = 'object'), schema_version int not null default 1,
  occurred_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(),
  unique(user_id,account_id,id), foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create table public.configuration_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  event_type text not null, payload jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.daily_contexts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  trading_day date not null, narrative text not null check(length(narrative) <= 20000),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);

-- Reserved V1 schema. No write RPCs or storage policies until corresponding slice.
create table public.chart_assets (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  object_key text not null unique, sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  timeframe text not null check(timeframe in ('D1','H4','H1','M30','M15','M5','M3')),
  mime_type text not null check(mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size bigint not null check(byte_size between 1 and 10485760),
  recorded_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,id),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create table public.plan_chart_assets (
  user_id uuid not null, account_id uuid not null, plan_id uuid not null, asset_id uuid not null,
  primary key(plan_id,asset_id), foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id),
  foreign key(user_id,account_id,asset_id) references public.chart_assets(user_id,account_id,id)
);
create table public.ai_analysis_attempts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  strategy_version_id uuid not null, stage text not null check(stage in ('A','B','RECONCILER','POSTTRADE')),
  provider text not null, model text not null, prompt_version text not null, schema_version text not null,
  input_manifest jsonb not null, raw_response jsonb, validated_output jsonb,
  status text not null check(status in ('PENDING','VALID','INVALID','REFUSED','INCOMPLETE','FAILED')),
  validation_errors jsonb, recorded_at timestamptz not null default clock_timestamp(),
  check(status <> 'VALID' or validated_output is not null),
  foreign key(user_id,account_id,strategy_version_id) references public.strategy_versions(user_id,account_id,id)
);
create table public.trade_reviews (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, plan_id uuid not null,
  financial_result jsonb not null, process_result jsonb not null, schema_version int not null default 1,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create table public.strategy_experiments (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
  original_strategy_version_id uuid not null, experimental_strategy_version_id uuid not null,
  hypothesis text not null, original_rule text not null, experimental_rule text not null,
  start_date date not null, recorded_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,id),
  foreign key(user_id,account_id,original_strategy_version_id) references public.strategy_versions(user_id,account_id,id),
  foreign key(user_id,account_id,experimental_strategy_version_id) references public.strategy_versions(user_id,account_id,id)
);
create table public.experiment_reviews (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, experiment_id uuid not null,
  sample_size int not null check(sample_size >= 0), results jsonb not null,
  decision text not null check(decision in ('KEEP_TESTING','PROMOTE','REJECT')), recorded_at timestamptz not null default clock_timestamp(),
  foreign key(user_id,account_id,experiment_id) references public.strategy_experiments(user_id,account_id,id)
);

create function private.reject_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Immutable record: append an event or create a new version.'; end $$;

do $$ declare t text; begin
  foreach t in array array['accounts','account_observations','strategy_versions','risk_plan_versions','instrument_versions','risk_evaluations','trade_plans','trade_events','configuration_events','daily_contexts','chart_assets','plan_chart_assets','ai_analysis_attempts','trade_reviews','strategy_experiments','experiment_reviews'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy read_own on public.%I for select to authenticated using (user_id = (select auth.uid()))',t);
    execute format('create trigger immutable_record before update or delete on public.%I for each row execute function private.reject_mutation()',t);
  end loop;
end $$;

create function private.positive_money(v text) returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if v is null or v !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then raise exception 'Money requires up to two decimal places'; end if;
  return private.positive_decimal(v);
end $$;

create function private.strategy_day(p_now timestamptz) returns date language sql immutable set search_path = '' as $$
  select ((p_now at time zone 'UTC') - interval '5 hours')::date
$$;
create function private.strategy_session(p_now timestamptz) returns text language sql immutable set search_path = '' as $$
  select case when t >= time '18:00' or t < time '01:00' then 'ASIA' when t < time '02:00' then 'JUDAS' when t < time '12:00' then 'ACTIVE_KILL_ZONE' else 'DEAD_POOL' end
  from (select ((p_now at time zone 'UTC') - interval '5 hours')::time as t) s
$$;
create function private.issue(code text, severity text, message text) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_array(jsonb_build_object('code',code,'severity',severity,'message',message))
$$;
create function private.positive_decimal(v text) returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if v is null or v !~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then raise exception 'Invalid decimal input'; end if;
  if v::numeric <= 0 then raise exception 'Value must be positive'; end if;
  return v::numeric;
end $$;

create function private.evaluate_risk(p jsonb, a public.accounts, o public.account_observations, r public.risk_plan_versions, i public.instrument_versions, strategy_id uuid, p_now timestamptz, slots int, consumed numeric, duplicate boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  issues jsonb := '[]'; calc jsonb := null; result jsonb;
  entry numeric; stop numeric; target numeric; risk_pct numeric; distance numeric; ticks numeric;
  budget numeric; permitted numeric; qty numeric; nominal numeric; reward_distance numeric; rr numeric;
  session text := private.strategy_session(p_now);
begin
  result := jsonb_build_object('engineVersion','1.0','evaluatedAt',p_now,'tradingDay',private.strategy_day(p_now),'session',session,'strategyVersionId',strategy_id,'riskPlanVersionId',r.id,'status','TRADE_BLOCKED');
  begin
    if jsonb_typeof(p) <> 'object' or (select count(*) from jsonb_object_keys(p)) <> 11 or not (p ?& array['instrumentId','direction','model','entry','stop','target','riskPercent','narrative','contractConfirmed','news','contradiction']) then raise exception 'Invalid proposal shape'; end if;
    if (p->>'direction' in ('LONG','SHORT')) is not true or (p->>'model' in ('OB_FIRST_TOUCH','OTE')) is not true or (p->>'news' in ('UNKNOWN','CLEAR','RESTRICTED')) is not true or jsonb_typeof(p->'contractConfirmed') <> 'boolean' or jsonb_typeof(p->'contradiction') <> 'boolean' or jsonb_typeof(p->'narrative') <> 'string' or length(trim(p->>'narrative')) not between 1 and 5000 then raise exception 'Invalid proposal values'; end if;
    if jsonb_typeof(p->'entry') <> 'string' or jsonb_typeof(p->'target') <> 'string' or jsonb_typeof(p->'riskPercent') <> 'string' then raise exception 'Prices must be decimal strings'; end if;
    entry := private.positive_decimal(p->>'entry'); target := private.positive_decimal(p->>'target'); risk_pct := private.positive_decimal(p->>'riskPercent');
    if (p->>'instrumentId')::uuid <> i.id or i.currency <> a.currency then issues := issues || private.issue('INSTRUMENT_MISMATCH','BLOCK','Instrument must match account currency.'); end if;
    if not (p->>'contractConfirmed')::boolean then issues := issues || private.issue('CONTRACT_UNCONFIRMED','BLOCK','Confirm your broker contract specification.'); end if;
    if p->>'stop' is null then
      return result || jsonb_build_object('issues',issues || private.issue('MISSING_STOP','BLOCK','A stop loss is required.'),'calculations',null);
    end if;
    if jsonb_typeof(p->'stop') <> 'string' then raise exception 'Stop must be a decimal string'; end if;
    stop := private.positive_decimal(p->>'stop');
  exception when others then
    return result || jsonb_build_object('issues',private.issue('INVALID_INPUT','BLOCK','Invalid proposal. Check required fields, decimal prices, model and evidence flags.'),'calculations',null);
  end;
  if ((p->>'direction' = 'LONG' and stop < entry and target > entry) or (p->>'direction' = 'SHORT' and stop > entry and target < entry)) is not true then
    return result || jsonb_build_object('issues',issues || private.issue('PRICE_GEOMETRY','BLOCK','Stop and target must be on the correct sides of entry.'),'calculations',null);
  end if;
  if mod(entry,i.tick_size) <> 0 or mod(stop,i.tick_size) <> 0 or mod(target,i.tick_size) <> 0 then issues := issues || private.issue('OFF_TICK','BLOCK','Prices must align to tick size.'); end if;
  distance := abs(entry-stop); ticks := distance/i.tick_size;
  budget := trunc(o.equity*risk_pct/100,2); permitted := trunc(o.equity*r.max_risk_percent/100,2);
  qty := div(budget,ticks*i.tick_value*i.quantity_step)*i.quantity_step;
  nominal := qty*ticks*i.tick_value; reward_distance := abs(target-entry); rr := reward_distance/distance;
  if nominal > budget then raise exception 'Sizing invariant violated'; end if;
  calc := jsonb_build_object('budget',budget::text,'permittedRisk',permitted::text,'stopDistance',distance::text,'stopTicks',ticks::text,'stopPips',case when i.pip_size is null then null else (distance/i.pip_size)::text end,'plannedRR',trunc(rr,8)::text,'quantity',qty::text,'nominalRisk',nominal::text,'plannedReward',(reward_distance/i.tick_size*i.tick_value*qty)::text);
  if risk_pct > r.max_risk_percent then issues := issues || private.issue('RISK_LIMIT','BLOCK','Requested risk exceeds the risk-plan maximum.'); end if;
  if qty < i.minimum_quantity then issues := issues || private.issue('MINIMUM_QUANTITY','BLOCK','Risk budget is below the minimum position size.'); end if;
  if reward_distance < distance*r.min_rr then issues := issues || private.issue('MIN_RR',r.rr_policy,'Planned RR is below the configured minimum.'); end if;
  if slots >= r.max_daily_trades then issues := issues || private.issue('MAX_TRADES','BLOCK','Maximum daily trades and reserved slots reached.'); end if;
  if session = 'DEAD_POOL' then issues := issues || private.issue('DEAD_POOL','BLOCK','Dead Pool: no new discretionary plans from 12:00 to 18:00 UTC-5.');
  elsif session <> 'ACTIVE_KILL_ZONE' then issues := issues || private.issue('OUTSIDE_ACTIVE','WARN','Outside the active kill zone.'); end if;
  if duplicate then issues := issues || private.issue('DUPLICATE','BLOCK','An identical plan already reserves a slot today.'); end if;
  if o.trading_day <> private.strategy_day(p_now) then issues := issues || private.issue('STALE_EQUITY','BLOCK','Record or reconfirm current account values for this trading day before locking.'); end if;
  if (p->>'contradiction')::boolean then issues := issues || private.issue('STRATEGY_CONTRADICTION','BLOCK','A strategy contradiction has been reported.'); end if;
  if p->>'news' = 'RESTRICTED' then issues := issues || private.issue('NEWS_RESTRICTED',r.news_policy,'A restricted news environment has been reported.'); end if;
  if p->>'news' = 'UNKNOWN' then issues := issues || private.issue('NEWS_UNKNOWN','WARN','Economic news has not been verified.'); end if;
  if r.daily_risk_cap is null then issues := issues || private.issue('DAILY_RISK_UNCONFIGURED','WARN','No daily monetary risk cap is configured.');
  elsif consumed+nominal > r.daily_risk_cap then issues := issues || private.issue('DAILY_RISK_LIMIT','BLOCK','Daily monetary risk cap would be exceeded.'); end if;
  if r.daily_loss_cap is null then issues := issues || private.issue('DAILY_LOSS_UNCONFIGURED','WARN','No daily loss cap is configured.');
  elsif o.trading_day <> private.strategy_day(p_now) or o.gross_loss_today is null then issues := issues || private.issue('DAILY_LOSS_UNKNOWN','BLOCK','A configured loss cap requires a reported daily loss total.');
  elsif o.gross_loss_today+consumed+nominal > r.daily_loss_cap then issues := issues || private.issue('DAILY_LOSS_LIMIT','BLOCK','Losses plus reserved exposure exceed the loss cap.'); end if;
  issues := issues || private.issue('COSTS_UNKNOWN','WARN','Nominal stop risk excludes fees, gaps and slippage.');
  return result || jsonb_build_object('status',case when exists(select 1 from jsonb_array_elements(issues) x where x->>'severity'='BLOCK') then 'TRADE_BLOCKED' else 'RISK_APPROVED' end,'issues',issues,'calculations',calc);
end $$;

create function public.lock_trade_plan(p_account_id uuid, p_proposal jsonb, p_idempotency_key uuid, p_expected_risk_id uuid, p_expected_observation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.accounts; o public.account_observations; r public.risk_plan_versions; i public.instrument_versions;
  s public.strategy_versions; existing public.trade_plans; new_plan public.trade_plans;
  v_now timestamptz; slots int; consumed numeric; duplicate boolean; result jsonb; evaluation_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into a from public.accounts where id=p_account_id and user_id=auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  select * into existing from public.trade_plans where account_id=a.id and idempotency_key=p_idempotency_key;
  if found then
    if existing.proposal <> p_proposal then raise exception 'Idempotency key was already used for different input'; end if;
    return jsonb_build_object('planId',existing.id,'result',existing.risk_result,'replayed',true);
  end if;
  v_now := clock_timestamp();
  select * into r from public.risk_plan_versions where account_id=a.id and effective_day <= private.strategy_day(v_now) order by effective_day desc,created_at desc,id desc limit 1;
  select * into o from public.account_observations where account_id=a.id order by recorded_at desc,id desc limit 1;
  select * into s from public.strategy_versions where account_id=a.id and version='ICT V1.0';
  select * into i from public.instrument_versions where account_id=a.id and id=(p_proposal->>'instrumentId')::uuid;
  if r.id is null or s.id is null or o.id is null or i.id is null then raise exception 'Account configuration is incomplete'; end if;
  if r.id is distinct from p_expected_risk_id or o.id is distinct from p_expected_observation_id then raise exception 'Account or risk plan changed. Refresh and recheck the proposal.'; end if;
  select count(*),coalesce(sum(nominal_risk),0) into slots,consumed from public.trade_plans where account_id=a.id and trading_day=private.strategy_day(v_now);
  select exists(select 1 from public.trade_plans where account_id=a.id and trading_day=private.strategy_day(v_now)
    and proposal->>'instrumentId'=p_proposal->>'instrumentId' and proposal->>'direction'=p_proposal->>'direction' and proposal->>'model'=p_proposal->>'model'
    and (proposal->>'entry')::numeric=(p_proposal->>'entry')::numeric and (proposal->>'stop')::numeric=(p_proposal->>'stop')::numeric and (proposal->>'target')::numeric=(p_proposal->>'target')::numeric) into duplicate;
  result := private.evaluate_risk(p_proposal,a,o,r,i,s.id,v_now,slots,consumed,duplicate);
  insert into public.risk_evaluations(user_id,account_id,proposal,result) values(a.user_id,a.id,p_proposal,result) returning id into evaluation_id;
  if result->>'status'='TRADE_BLOCKED' then return jsonb_build_object('planId',null,'result',result,'replayed',false); end if;
  insert into public.trade_plans(user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at)
    values(a.user_id,a.id,s.id,r.id,i.id,o.id,evaluation_id,p_idempotency_key,p_proposal,result,(result#>>'{calculations,nominalRisk}')::numeric,private.strategy_day(v_now),v_now) returning * into new_plan;
  insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at) values(a.user_id,a.id,new_plan.id,'PLAN_LOCKED',jsonb_build_object('risk_evaluation_id',evaluation_id,'setup_status','NOT_EVALUATED'),v_now);
  return jsonb_build_object('planId',new_plan.id,'result',result,'replayed',false);
end $$;

create function public.record_observation(p_account_id uuid,p_equity text,p_balance text,p_gross_loss text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; a public.accounts; loss numeric;
begin
  select * into a from public.accounts where id=p_account_id and user_id=auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  if p_gross_loss is not null then
    if p_gross_loss !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then raise exception 'Invalid gross loss'; end if;
    loss := p_gross_loss::numeric;
  end if;
  insert into public.account_observations(user_id,account_id,equity,balance,gross_loss_today,trading_day)
    values(a.user_id,a.id,private.positive_money(p_equity),private.positive_money(p_balance),loss,private.strategy_day(clock_timestamp())) returning id into v_id;
  return v_id;
end $$;
create function public.create_risk_version(p_account_id uuid,p_config jsonb,p_immediate boolean default false,p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.accounts; v_id uuid; day date; version_count int;
begin
  select * into a from public.accounts where id=p_account_id and user_id=auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  if p_immediate and length(trim(coalesce(p_reason,''))) < 5 then raise exception 'An immediate change requires an override reason'; end if;
  day := private.strategy_day(clock_timestamp()) + case when p_immediate then 0 else 1 end;
  select count(*) into version_count from public.risk_plan_versions where account_id=a.id;
  insert into public.risk_plan_versions(user_id,account_id,version,effective_day,max_risk_percent,max_daily_trades,min_rr,rr_policy,news_policy,daily_risk_cap,daily_loss_cap,override_reason)
    values(a.user_id,a.id,'Risk Plan V1.'||version_count,day,private.positive_decimal(p_config->>'maxRiskPercent'),(p_config->>'maxDailyTrades')::int,private.positive_decimal(p_config->>'minRR'),p_config->>'rrPolicy',p_config->>'newsPolicy',case when p_config->>'dailyRiskCap' is null then null else private.positive_money(p_config->>'dailyRiskCap') end,case when p_config->>'dailyLossCap' is null then null else private.positive_money(p_config->>'dailyLossCap') end,case when p_immediate then p_reason else null end) returning id into v_id;
  insert into public.configuration_events(user_id,account_id,event_type,payload) values(a.user_id,a.id,'RISK_VERSION_CREATED',jsonb_build_object('version_id',v_id,'effective_day',day,'immediate',p_immediate,'reason',p_reason));
  return v_id;
end $$;
create function public.append_plan_note(p_plan_id uuid,p_note text) returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.trade_plans; v_id uuid;
begin
  select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid();
  if not found then raise exception 'Plan not found'; end if;
  if length(trim(coalesce(p_note,''))) not between 1 and 5000 then raise exception 'Note must contain 1–5000 characters'; end if;
  perform 1 from public.accounts where id=p.account_id for update;
  insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at) values(p.user_id,p.account_id,p.id,'NOTE_ADDED',jsonb_build_object('note',p_note),clock_timestamp()) returning id into v_id;
  return v_id;
end $$;
create function public.save_daily_context(p_account_id uuid,p_narrative text) returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.accounts; v_id uuid;
begin
  select * into a from public.accounts where id=p_account_id and user_id=auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  insert into public.daily_contexts(user_id,account_id,trading_day,narrative) values(a.user_id,a.id,private.strategy_day(clock_timestamp()),p_narrative) returning id into v_id;
  return v_id;
end $$;

revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.lock_trade_plan(uuid,jsonb,uuid,uuid,uuid), public.record_observation(uuid,text,text,text), public.create_risk_version(uuid,jsonb,boolean,text), public.append_plan_note(uuid,text), public.save_daily_context(uuid,text) from public,anon;
grant execute on function public.lock_trade_plan(uuid,jsonb,uuid,uuid,uuid), public.record_observation(uuid,text,text,text), public.create_risk_version(uuid,jsonb,boolean,text), public.append_plan_note(uuid,text), public.save_daily_context(uuid,text) to authenticated;
