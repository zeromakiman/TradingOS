-- Additive persistence hardening. Historical 0001/0002 rows and results remain immutable.
create table public.bootstrap_requests (
  user_id uuid not null references auth.users(id), idempotency_key uuid not null,
  account_id uuid not null, input jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
  primary key(user_id,idempotency_key),
  foreign key(user_id,account_id) references public.accounts(user_id,id)
);
alter table public.bootstrap_requests enable row level security;
revoke all on public.bootstrap_requests from public,anon,authenticated;
grant select on public.bootstrap_requests to authenticated;
create policy read_own on public.bootstrap_requests for select to authenticated using(user_id=(select auth.uid()));
create trigger immutable_record before update or delete on public.bootstrap_requests for each row execute function private.reject_mutation();

create function public.bootstrap_demo_account(p_idempotency_key uuid,p_name text,p_equity text,p_balance text)
returns uuid language plpgsql security definer set search_path='' as $$
declare normalized jsonb; existing public.bootstrap_requests; account_id uuid;
begin
  if auth.uid() is null or p_idempotency_key is null then raise exception 'Authentication and request key required'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'Account name must contain 1–100 characters'; end if;
  normalized:=jsonb_build_object('name',trim(p_name),'equity',private.positive_money(p_equity),'balance',private.positive_money(p_balance));
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_idempotency_key::text,0));
  select * into existing from public.bootstrap_requests where user_id=auth.uid() and idempotency_key=p_idempotency_key;
  if found then
    if existing.input<>normalized then raise exception 'Bootstrap request key already used for different input'; end if;
    return existing.account_id;
  end if;
  account_id:=public.create_demo_account(trim(p_name),p_equity,p_balance);
  insert into public.bootstrap_requests(user_id,idempotency_key,account_id,input) values(auth.uid(),p_idempotency_key,account_id,normalized);
  return account_id;
end $$;
revoke all on function public.create_demo_account(text,text,text) from authenticated;
revoke all on function public.bootstrap_demo_account(uuid,text,text,text) from public,anon;
grant execute on function public.bootstrap_demo_account(uuid,text,text,text) to authenticated;

create index observations_latest on public.account_observations(account_id,recorded_at desc,id desc);
create index risk_versions_effective on public.risk_plan_versions(account_id,effective_day desc,created_at desc,id desc);
create index journal_page on public.trade_plans(user_id,account_id,locked_at desc,id desc);
create index event_history on public.trade_events(user_id,plan_id,sequence);
create index daily_context_latest on public.daily_contexts(user_id,account_id,trading_day,recorded_at desc,id desc);
create index evaluation_history on public.risk_evaluations(user_id,account_id,recorded_at desc,id desc);

alter table public.risk_evaluations add column account_observation_id uuid,
  add column strategy_version_id uuid, add column risk_plan_version_id uuid,
  add column instrument_version_id uuid, add column source text not null default 'LOCK_RECHECK',
  add constraint evaluation_source check(source in ('EXPLICIT_CHECK','LOCK_RECHECK')),
  add constraint evaluation_observation_fk foreign key(user_id,account_id,account_observation_id) references public.account_observations(user_id,account_id,id),
  add constraint evaluation_strategy_fk foreign key(user_id,account_id,strategy_version_id) references public.strategy_versions(user_id,account_id,id),
  add constraint evaluation_risk_fk foreign key(user_id,account_id,risk_plan_version_id) references public.risk_plan_versions(user_id,account_id,id),
  add constraint evaluation_instrument_fk foreign key(user_id,account_id,instrument_version_id) references public.instrument_versions(user_id,account_id,id);

create function private.risk_report(p jsonb,a public.accounts,o public.account_observations,r public.risk_plan_versions,i public.instrument_versions,strategy_id uuid,p_now timestamptz,slots int,consumed numeric,duplicate boolean)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb; issues jsonb; rules jsonb:='[]'; code text; found_issue jsonb; outcome text;
  parsed boolean; has_math boolean; codes text[]:=array['INVALID_INPUT','INSTRUMENT_MISMATCH','CONTRACT_UNCONFIRMED','MISSING_STOP','PRICE_GEOMETRY','OFF_TICK','RISK_LIMIT','SIZING_INVARIANT','MINIMUM_QUANTITY','MIN_RR','MAX_TRADES','DEAD_POOL','DUPLICATE','STALE_EQUITY','STRATEGY_CONTRADICTION','NEWS_RESTRICTED','DAILY_RISK_LIMIT','DAILY_LOSS_LIMIT'];
begin
  result:=private.evaluate_risk(p,a,o,r,i,strategy_id,p_now,slots,consumed,duplicate);
  issues:=result->'issues'; has_math:=jsonb_typeof(result->'calculations')='object';
  parsed:=not exists(select 1 from jsonb_array_elements(issues) x where x->>'code'='INVALID_INPUT');
  if slots>=r.max_daily_trades and not exists(select 1 from jsonb_array_elements(issues) x where x->>'code'='MAX_TRADES') then issues:=issues||private.issue('MAX_TRADES','BLOCK','Maximum daily trades and reserved slots reached.'); end if;
  if private.strategy_session(p_now)='DEAD_POOL' and not exists(select 1 from jsonb_array_elements(issues) x where x->>'code'='DEAD_POOL') then issues:=issues||private.issue('DEAD_POOL','BLOCK','Dead Pool blocks new discretionary plans from 12:00 to 18:00 UTC-5.'); end if;
  if o.trading_day<>private.strategy_day(p_now) and not exists(select 1 from jsonb_array_elements(issues) x where x->>'code'='STALE_EQUITY') then issues:=issues||private.issue('STALE_EQUITY','BLOCK','Reconfirm account values for the current strategy day.'); end if;
  foreach code in array codes loop
    select x into found_issue from jsonb_array_elements(issues) x where x->>'code'=code limit 1;
    if found_issue is not null then outcome:=found_issue->>'severity';
    elsif code=any(array['INVALID_INPUT','MAX_TRADES','DEAD_POOL','STALE_EQUITY']) then outcome:='PASS';
    elsif not parsed then outcome:='NOT_EVALUATED';
    elsif code=any(array['INSTRUMENT_MISMATCH','CONTRACT_UNCONFIRMED','MISSING_STOP']) then outcome:='PASS';
    elsif not has_math then outcome:='NOT_EVALUATED';
    elsif code='NEWS_RESTRICTED' and p->>'news'='UNKNOWN' then outcome:='NOT_EVALUATED';
    elsif code='DAILY_RISK_LIMIT' and r.daily_risk_cap is null then outcome:='NOT_EVALUATED';
    elsif code='DAILY_LOSS_LIMIT' and r.daily_loss_cap is null then outcome:='NOT_EVALUATED';
    elsif code='DAILY_LOSS_LIMIT' and exists(select 1 from jsonb_array_elements(issues) x where x->>'code'='DAILY_LOSS_UNKNOWN') then outcome:='BLOCK';
    else outcome:='PASS'; end if;
    rules:=rules||jsonb_build_array(jsonb_build_object('rule',code,'outcome',outcome,'message',coalesce(found_issue->>'message',case when outcome='NOT_EVALUATED' then 'Not evaluated: required inputs or policy are unavailable.' when code='STRATEGY_CONTRADICTION' then 'No contradiction reported; qualitative setup is not evaluated.' when code='DAILY_LOSS_LIMIT' and outcome='BLOCK' then 'Daily loss data is required.' else 'Check passed.' end)));
  end loop;
  return result||jsonb_build_object('reportVersion','1.1','decision',case when exists(select 1 from jsonb_array_elements(issues) x where x->>'severity'='BLOCK') then 'BLOCKED' else 'APPROVED' end,'status',case when exists(select 1 from jsonb_array_elements(issues) x where x->>'severity'='BLOCK') then 'TRADE_BLOCKED' else 'RISK_APPROVED' end,'issues',issues,'ruleResults',rules,
    'requestedRiskPercent',case when parsed then p->>'riskPercent' else null end,
    'targetDistance',case when has_math then abs((p->>'target')::numeric-(p->>'entry')::numeric)::text else null end,
    'sessionEligible',private.strategy_session(p_now)<>'DEAD_POOL',
    'snapshot',jsonb_build_object('accountObservationId',o.id,'observationDay',o.trading_day,'equity',o.equity::text,'currency',a.currency,'instrumentVersionId',i.id,'slotsUsed',slots,'executedTrades',null,'maximumDailyTrades',r.max_daily_trades,'riskConsumed',consumed::text,'grossLoss',case when o.trading_day=private.strategy_day(p_now) then o.gross_loss_today::text else null end));
end $$;

-- One internal path obtains trusted context, persists a decision and optionally locks.
create function private.assess_plan(p_account_id uuid,p_proposal jsonb,p_key uuid,p_expected_risk_id uuid,p_expected_observation_id uuid,p_lock boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; o public.account_observations; r public.risk_plan_versions; i public.instrument_versions; s public.strategy_versions;
  existing public.trade_plans; new_plan public.trade_plans; v_now timestamptz; slots int; consumed numeric; duplicate boolean; result jsonb; evaluation_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_lock and p_key is null then raise exception 'Lock request key required'; end if;
  select * into a from public.accounts where id=p_account_id and user_id=auth.uid() for update;
  if not found then raise exception 'Account not found'; end if;
  if p_lock then
    select * into existing from public.trade_plans where account_id=a.id and idempotency_key=p_key;
    if found then
      if existing.proposal is distinct from p_proposal then raise exception 'Idempotency key already used for different input'; end if;
      return jsonb_build_object('planId',existing.id,'evaluationId',existing.risk_evaluation_id,'result',existing.risk_result,'replayed',true);
    end if;
  end if;
  v_now:=clock_timestamp();
  select * into r from public.risk_plan_versions where account_id=a.id and effective_day<=private.strategy_day(v_now) order by effective_day desc,created_at desc,id desc limit 1;
  select * into o from public.account_observations where account_id=a.id order by recorded_at desc,id desc limit 1;
  select * into s from public.strategy_versions where account_id=a.id and version='ICT V1.0';
  select * into i from public.instrument_versions where account_id=a.id and id=(p_proposal->>'instrumentId')::uuid;
  if r.id is null or o.id is null or s.id is null or i.id is null then raise exception 'Account configuration is incomplete'; end if;
  if r.id is distinct from p_expected_risk_id or o.id is distinct from p_expected_observation_id then raise exception 'Account or risk plan changed. Refresh and recheck.'; end if;
  select count(*),coalesce(sum(nominal_risk),0) into slots,consumed from public.trade_plans where account_id=a.id and trading_day=private.strategy_day(v_now);
  -- Numeric casts run only for lexically valid price strings; malformed requests remain blocked reports.
  duplicate:=false;
  if p_proposal->>'entry' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' and p_proposal->>'stop' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' and p_proposal->>'target' ~ '^[0-9]{1,12}(\.[0-9]{1,8})?$' then
    select exists(select 1 from public.trade_plans where account_id=a.id and trading_day=private.strategy_day(v_now)
      and (proposal->>'instrumentId')::uuid=i.id and proposal->>'direction'=p_proposal->>'direction' and proposal->>'model'=p_proposal->>'model'
      and (proposal->>'entry')::numeric=(p_proposal->>'entry')::numeric and (proposal->>'stop')::numeric=(p_proposal->>'stop')::numeric and (proposal->>'target')::numeric=(p_proposal->>'target')::numeric) into duplicate;
  end if;
  result:=private.risk_report(p_proposal,a,o,r,i,s.id,v_now,slots,consumed,duplicate);
  insert into public.risk_evaluations(user_id,account_id,proposal,result,account_observation_id,strategy_version_id,risk_plan_version_id,instrument_version_id,source)
    values(a.user_id,a.id,p_proposal,result,o.id,s.id,r.id,i.id,case when p_lock then 'LOCK_RECHECK' else 'EXPLICIT_CHECK' end) returning id into evaluation_id;
  if not p_lock or result->>'decision'='BLOCKED' then return jsonb_build_object('planId',null,'evaluationId',evaluation_id,'result',result,'replayed',false); end if;
  insert into public.trade_plans(user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at)
    values(a.user_id,a.id,s.id,r.id,i.id,o.id,evaluation_id,p_key,p_proposal,result,(result#>>'{calculations,nominalRisk}')::numeric,private.strategy_day(v_now),v_now) returning * into new_plan;
  insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at)
    values(a.user_id,a.id,new_plan.id,'PLAN_LOCKED',jsonb_build_object('risk_evaluation_id',evaluation_id,'setup_status','NOT_EVALUATED','actor',a.user_id,'source','USER_COMMAND'),v_now);
  return jsonb_build_object('planId',new_plan.id,'evaluationId',evaluation_id,'result',result,'replayed',false);
end $$;
create function public.evaluate_trade_plan(p_account_id uuid,p_proposal jsonb,p_expected_risk_id uuid,p_expected_observation_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select private.assess_plan(p_account_id,p_proposal,null,p_expected_risk_id,p_expected_observation_id,false)
$$;
create or replace function public.lock_trade_plan(p_account_id uuid,p_proposal jsonb,p_idempotency_key uuid,p_expected_risk_id uuid,p_expected_observation_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select private.assess_plan(p_account_id,p_proposal,p_idempotency_key,p_expected_risk_id,p_expected_observation_id,true)
$$;
revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.evaluate_trade_plan(uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.evaluate_trade_plan(uuid,jsonb,uuid,uuid) to authenticated;
notify pgrst,'reload schema';
