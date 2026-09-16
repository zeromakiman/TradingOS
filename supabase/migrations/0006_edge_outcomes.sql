-- Additive execution journal. No historical fills or outcomes are inferred.
create table public.trade_executions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, plan_id uuid not null unique,
 entry_price numeric not null check(entry_price>0), quantity numeric not null check(quantity>0),
 entered_at timestamptz not null, initial_risk numeric not null check(initial_risk>0),
 recorded_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,id),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create table public.trade_outcomes (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, plan_id uuid not null unique,
 execution_id uuid not null unique, exit_price numeric not null check(exit_price>0), exited_at timestamptz not null,
 fees numeric not null check(fees>=0), gross_pnl numeric not null, net_pnl numeric not null,
 realized_r numeric not null, outcome text not null check(outcome in ('WIN','LOSS','BREAKEVEN')),
 calculation_version text not null default 'FULL_CLOSE_V1' check(calculation_version='FULL_CLOSE_V1'),
 recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id),
 foreign key(user_id,account_id,execution_id) references public.trade_executions(user_id,account_id,id),
 check(net_pnl=gross_pnl-fees),
 check((outcome='WIN' and realized_r>0) or (outcome='LOSS' and realized_r<0) or (outcome='BREAKEVEN' and realized_r=0))
);
create table public.trade_dispositions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, plan_id uuid not null unique,
 status text not null check(status in ('SKIPPED','CANCELLED')), reason text not null check(length(trim(reason)) between 1 and 5000),
 recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create table public.trade_tag_revisions (
 id bigint generated always as identity primary key, user_id uuid not null, account_id uuid not null, plan_id uuid not null,
 setup_grade text check(setup_grade in ('A+','A','B','C','INVALID')),
 liquidity_context text check(liquidity_context in ('ARL_HIGH','ARL_LOW','PDH','PDL','PWH','PWL','KZ_HIGH','KZ_LOW','EQUAL_HIGHS','EQUAL_LOWS','OTHER')),
 mss_timeframe text check(mss_timeframe in ('M15','M5','M3')),
 source text not null default 'MANUAL' check(source='MANUAL'), recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['trade_executions','trade_outcomes','trade_dispositions','trade_tag_revisions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy read_own on public.%I for select to authenticated using (user_id=(select auth.uid()))',t);
  execute format('create trigger immutable_record before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
create index trade_executions_account_entry on public.trade_executions(account_id,entered_at,id);
create index trade_outcomes_account_exit on public.trade_outcomes(account_id,exited_at,id);
create index trade_tag_latest on public.trade_tag_revisions(plan_id,id desc);
create index setup_decision_latest on public.setup_human_decisions(proposal_id,recorded_at desc,id desc);

create function public.open_journal_trade(p_plan_id uuid,p_entry text,p_quantity text,p_entered_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.trade_plans; i public.instrument_versions; e public.trade_executions; price numeric; qty numeric; result uuid;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid() for update;
 if not found then raise exception 'Plan not found'; end if;
 price:=private.positive_decimal(p_entry); qty:=private.positive_decimal(p_quantity);
 select * into e from public.trade_executions where plan_id=p.id;
 if found then
  if e.entry_price=price and e.quantity=qty and e.entered_at=p_entered_at then return e.id; end if;
  raise exception 'Entry already recorded; original fill is immutable';
 end if;
 if exists(select 1 from public.trade_dispositions where plan_id=p.id) then raise exception 'Plan is skipped or cancelled'; end if;
 if p_entered_at is null or not isfinite(p_entered_at) or p_entered_at<p.locked_at or p_entered_at>clock_timestamp() then raise exception 'Entry must be after plan lock and not in the future'; end if;
 select * into i from public.instrument_versions where id=p.instrument_version_id;
 if mod(price,i.tick_size)<>0 or mod(qty,i.quantity_step)<>0 or qty<i.minimum_quantity then raise exception 'Fill must align with contract price and quantity increments'; end if;
 if (p.proposal->>'direction'='LONG' and price<=(p.proposal->>'stop')::numeric) or (p.proposal->>'direction'='SHORT' and price>=(p.proposal->>'stop')::numeric) then raise exception 'Actual entry must remain on the valid side of the original stop'; end if;
 insert into public.trade_executions(user_id,account_id,plan_id,entry_price,quantity,entered_at,initial_risk)
 values(p.user_id,p.account_id,p.id,price,qty,p_entered_at,p.nominal_risk) returning id into result;
 insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at)
 values(p.user_id,p.account_id,p.id,'TRADE_OPENED',jsonb_build_object('execution_id',result,'entry_price',price::text,'quantity',qty::text,'initial_risk',p.nominal_risk::text,'source','USER_REPORTED'),p_entered_at);
 return result;
end $$;

create function public.close_journal_trade(p_plan_id uuid,p_exit text,p_exited_at timestamptz,p_fees text default '0')
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.trade_plans; i public.instrument_versions; e public.trade_executions; o public.trade_outcomes; price numeric; fees numeric; gross numeric; net numeric; r numeric; result uuid; verdict text;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid() for update;
 if not found then raise exception 'Plan not found'; end if;
 price:=private.positive_decimal(p_exit);
 if p_fees is null or p_fees!~'^[0-9]{1,12}(\.[0-9]{1,2})?$' then raise exception 'Fees must be a nonnegative amount with at most two decimals'; end if;
 fees:=p_fees::numeric;
 select * into o from public.trade_outcomes where plan_id=p.id;
 if found then
  if o.exit_price=price and o.exited_at=p_exited_at and o.fees=fees then return o.id; end if;
  raise exception 'Trade already closed; original outcome is immutable';
 end if;
 select * into e from public.trade_executions where plan_id=p.id;
 if not found then raise exception 'Record the actual entry before closing'; end if;
 if p_exited_at is null or not isfinite(p_exited_at) or p_exited_at<e.entered_at or p_exited_at>clock_timestamp() then raise exception 'Exit must be after entry and not in the future'; end if;
 select * into i from public.instrument_versions where id=p.instrument_version_id;
 if mod(price,i.tick_size)<>0 then raise exception 'Exit must align with contract tick size'; end if;
 if exists(select 1 from public.trade_events where plan_id=p.id and event_type in ('PARTIAL_CLOSED','POSITION_ADDED')) then raise exception 'Multi-leg position requires a separate accounting flow'; end if;
 gross:=(price-e.entry_price)*case when p.proposal->>'direction'='LONG' then 1 else -1 end/i.tick_size*i.tick_value*e.quantity;
 net:=gross-fees; r:=net/e.initial_risk;
 verdict:=case when net>0 then 'WIN' when net<0 then 'LOSS' else 'BREAKEVEN' end;
 insert into public.trade_outcomes(user_id,account_id,plan_id,execution_id,exit_price,exited_at,fees,gross_pnl,net_pnl,realized_r,outcome)
 values(p.user_id,p.account_id,p.id,e.id,price,p_exited_at,fees,gross,net,r,verdict) returning id into result;
 insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at)
 values(p.user_id,p.account_id,p.id,'TRADE_CLOSED',jsonb_build_object('outcome_id',result,'exit_price',price::text,'fees',fees::text,'realized_r',r::text,'outcome',verdict,'calculation_version','FULL_CLOSE_V1'),p_exited_at);
 return result;
end $$;

create function public.set_journal_disposition(p_plan_id uuid,p_status text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare p public.trade_plans;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid() for update;
 if not found then raise exception 'Plan not found'; end if;
 if exists(select 1 from public.trade_executions where plan_id=p.id) then raise exception 'An executed trade must be closed'; end if;
 if exists(select 1 from public.trade_dispositions where plan_id=p.id and status=p_status and reason=p_reason) then return; end if;
 insert into public.trade_dispositions(user_id,account_id,plan_id,status,reason) values(p.user_id,p.account_id,p.id,p_status,p_reason);
 insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at) values(p.user_id,p.account_id,p.id,'PLAN_CANCELLED',jsonb_build_object('status',p_status,'reason',p_reason),clock_timestamp());
end $$;
create function public.tag_journal_trade(p_plan_id uuid,p_grade text default null,p_liquidity text default null,p_mss text default null)
returns void language plpgsql security definer set search_path='' as $$
declare p public.trade_plans;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid();
 if not found then raise exception 'Plan not found'; end if;
 insert into public.trade_tag_revisions(user_id,account_id,plan_id,setup_grade,liquidity_context,mss_timeframe) values(p.user_id,p.account_id,p.id,p_grade,p_liquidity,p_mss);
 insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at) values(p.user_id,p.account_id,p.id,'NOTE_ADDED',jsonb_build_object('note','Manual structured tags recorded','setup_grade',p_grade,'liquidity_context',p_liquidity,'mss_timeframe',p_mss,'source','MANUAL'),clock_timestamp());
end $$;
revoke all on function public.open_journal_trade(uuid,text,text,timestamptz),public.close_journal_trade(uuid,text,timestamptz,text),public.set_journal_disposition(uuid,text,text),public.tag_journal_trade(uuid,text,text,text) from public,anon;
grant execute on function public.open_journal_trade(uuid,text,text,timestamptz),public.close_journal_trade(uuid,text,timestamptz,text),public.set_journal_disposition(uuid,text,text),public.tag_journal_trade(uuid,text,text,text) to authenticated;

-- RLS remains active through this compact, uncached projection. No AI payloads or images.
create view public.journal_analytics with (security_invoker=true) as
 select p.id,p.account_id,p.locked_at,p.strategy_version_id,p.risk_plan_version_id,
 s.version strategy_version,r.version risk_plan_version,i.symbol instrument,
 p.proposal->>'model' entry_model,p.proposal->>'direction' direction,
 p.proposal->>'entry' planned_entry,p.proposal->>'stop' initial_stop,
 p.risk_result#>>'{calculations,quantity}' planned_quantity,
 p.nominal_risk::text initial_risk,(p.nominal_risk/obs.equity*100)::text risk_percent,
 (s.rules->>'utc_offset_minutes')::int strategy_offset,
 case when o.id is not null then 'CLOSED' when e.id is not null then 'TAKEN' when d.id is not null then d.status when h.decision='SKIPPED' then 'SKIPPED' when h.decision='TAKEN' then 'TAKEN' else 'LOCKED' end status,
 e.id execution_id,e.entry_price::text,e.quantity::text,e.entered_at,
 o.exit_price::text,o.exited_at,o.realized_r::text,o.outcome,o.fees::text,o.net_pnl::text,
 t.setup_grade,t.liquidity_context,t.mss_timeframe,t.source tag_source
 from public.trade_plans p
 join public.strategy_versions s on s.id=p.strategy_version_id
 join public.risk_plan_versions r on r.id=p.risk_plan_version_id
 join public.instrument_versions i on i.id=p.instrument_version_id
 join public.account_observations obs on obs.id=p.account_observation_id
 left join public.trade_executions e on e.plan_id=p.id
 left join public.trade_outcomes o on o.plan_id=p.id
 left join public.trade_dispositions d on d.plan_id=p.id
 left join lateral (select x.* from public.trade_tag_revisions x where x.plan_id=p.id order by x.id desc limit 1) t on true
 left join lateral (select x.decision from public.setup_human_decisions x join public.setup_locks l on l.proposal_id=x.proposal_id where l.plan_id=p.id order by x.recorded_at desc,x.id desc limit 1) h on true;
revoke all on public.journal_analytics from public,anon;
grant select on public.journal_analytics to authenticated;
