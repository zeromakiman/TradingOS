-- 0011 requires a calendar week and WEEKLY_REVIEW. Recent samples need exact trade identities instead.
-- Additive advisory tables and service-only RPCs; no trade, risk or accounting changes.
create table public.recent_ai_analyses (
 id uuid primary key, user_id uuid not null, account_id uuid not null,
 requested_sample integer not null check(requested_sample in (10,20,30)), actual_sample integer not null check(actual_sample between 1 and requested_sample),
 trade_ids uuid[] not null check(cardinality(trade_ids)=actual_sample), captured_at timestamptz not null,
 facts jsonb not null check(jsonb_typeof(facts)='object'),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 operation jsonb not null check(operation->>'id' is not distinct from 'RECENT_TRADES_ANALYSIS'),
 contract jsonb not null check(jsonb_typeof(contract)='object'),
 created_at timestamptz not null default clock_timestamp(),
 deadline_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 unique(user_id,account_id,id),
 foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create index on public.recent_ai_analyses(account_id,requested_sample,created_at desc,id desc);
create table public.recent_ai_analysis_results (
 review_id uuid primary key, user_id uuid not null, account_id uuid not null,
 status text not null check(status in ('COMPLETED','FAILED')),
 interpretation jsonb, error_code text, raw_output jsonb,
 reservation_id uuid, created_at timestamptz not null default clock_timestamp(),
 check((status='COMPLETED' and interpretation is not null and jsonb_typeof(interpretation)='object' and error_code is null) or (status='FAILED' and interpretation is null and error_code is not null)),
 foreign key(user_id,account_id,review_id) references public.recent_ai_analyses(user_id,account_id,id),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['recent_ai_analyses','recent_ai_analysis_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
create function public.start_recent_ai_analysis(p_id uuid,p_user_id uuid,p_account_id uuid,p_requested integer,p_trade_ids uuid[],p_captured_at timestamptz,p_facts jsonb,p_hash text,p_operation jsonb,p_contract jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare existing public.recent_ai_analyses; expected uuid[];
begin
 perform 1 from public.accounts where id=p_account_id and user_id=p_user_id for update;
 if not found then raise exception 'Account not found'; end if;
 select * into existing from public.recent_ai_analyses where id=p_id;
 if found then
  if existing.user_id<>p_user_id or existing.account_id<>p_account_id or existing.requested_sample<>p_requested then raise exception 'Analysis not found'; end if;
  return false;
 end if;
 if p_requested is null or p_requested not in (10,20,30) or p_captured_at is null or p_captured_at>clock_timestamp() or p_captured_at<clock_timestamp()-interval '10 minutes' then raise exception 'Invalid sample snapshot'; end if;
 select array(select p.id from public.trade_plans p join public.trade_outcomes o on o.plan_id=p.id and o.user_id=p.user_id and o.account_id=p.account_id where p.account_id=p_account_id and p.user_id=p_user_id and o.exited_at<=p_captured_at order by o.exited_at desc,p.id asc limit p_requested) into expected;
 if cardinality(expected)=0 or p_trade_ids is distinct from expected then raise exception 'Sample changed or is not the most recent completed trades; refresh'; end if;
 if p_facts->>'version' is distinct from 'RECENT_TRADES_FACTS_V1' or p_facts->'sample'->>'requested' is distinct from p_requested::text or p_facts->'sample'->>'actual' is distinct from cardinality(expected)::text or p_facts->'sample'->'tradeIds' is distinct from to_jsonb(expected) or (p_facts->>'capturedAt')::timestamptz is distinct from p_captured_at then raise exception 'Sample metadata mismatch'; end if;
 if (select jsonb_agg(t->'tradeId' order by n) from jsonb_array_elements(p_facts->'trades') with ordinality as x(t,n)) is distinct from to_jsonb(expected) then raise exception 'Sample facts mismatch'; end if;
 if exists(select 1 from public.recent_ai_analyses r where r.account_id=p_account_id and r.deadline_at>clock_timestamp() and not exists(select 1 from public.recent_ai_analysis_results x where x.review_id=r.id)) then raise exception 'Analysis already running'; end if;
 insert into public.recent_ai_analyses(id,user_id,account_id,requested_sample,actual_sample,trade_ids,captured_at,facts,input_hash,operation,contract)
 values(p_id,p_user_id,p_account_id,p_requested,cardinality(expected),expected,p_captured_at,p_facts,p_hash,p_operation,p_contract);
 return true;
end $$;
create function public.authorize_recent_ai_analysis(p_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.recent_ai_analyses r join public.accounts a on a.id=r.account_id and a.user_id=r.user_id where r.id=p_id and r.user_id=p_user_id and r.deadline_at>clock_timestamp() and not exists(select 1 from public.recent_ai_analysis_results x where x.review_id=r.id)) then raise exception 'Review unavailable'; end if;
end $$;
create function public.finish_recent_ai_analysis(p_id uuid,p_user_id uuid,p_status text,p_interpretation jsonb,p_error text,p_raw jsonb,p_reservation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.recent_ai_analyses;
begin
 select * into r from public.recent_ai_analyses where id=p_id and user_id=p_user_id for update;
 if not found then raise exception 'Review not found'; end if;
 if p_reservation_id is not null and not exists(select 1 from public.ai_request_reservations where id=p_reservation_id and user_id=r.user_id and account_id=r.account_id and operation_id=r.id and operation='RECENT_TRADES_ANALYSIS') then raise exception 'Reservation mismatch'; end if;
 if p_status='COMPLETED' and not exists(select 1 from public.ai_usage_records where reservation_id=p_reservation_id and user_id=r.user_id and disposition='SETTLED') then raise exception 'Usage must be reconciled before completion'; end if;
 insert into public.recent_ai_analysis_results(review_id,user_id,account_id,status,interpretation,error_code,raw_output,reservation_id)
 values(r.id,r.user_id,r.account_id,p_status,p_interpretation,p_error,p_raw,p_reservation_id);
end $$;
revoke all on function public.start_recent_ai_analysis(uuid,uuid,uuid,integer,uuid[],timestamptz,jsonb,text,jsonb,jsonb),public.authorize_recent_ai_analysis(uuid,uuid),public.finish_recent_ai_analysis(uuid,uuid,text,jsonb,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.start_recent_ai_analysis(uuid,uuid,uuid,integer,uuid[],timestamptz,jsonb,text,jsonb,jsonb),public.authorize_recent_ai_analysis(uuid,uuid),public.finish_recent_ai_analysis(uuid,uuid,text,jsonb,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
