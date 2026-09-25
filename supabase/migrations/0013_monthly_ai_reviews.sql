-- Weekly (0011) and recent-N (0012) tables have operation-specific period constraints.
-- Monthly history is additive; existing history and all deterministic tables remain unchanged.
create table public.monthly_ai_reviews (
 id uuid primary key, user_id uuid not null, account_id uuid not null,
 month_start date not null check(extract(day from month_start)=1 and month_start between date '2000-01-01' and date '2099-12-01'),
 period_start timestamptz not null, period_end_exclusive timestamptz not null,
 trade_ids uuid[] not null, sample_size integer not null check(sample_size between 1 and 120),
 check(cardinality(trade_ids)=sample_size),
 check(period_start=(month_start::timestamp+interval '5 hours') at time zone 'UTC'),
 check(period_end_exclusive=(month_start::timestamp+interval '1 month 5 hours') at time zone 'UTC'),
 facts jsonb not null check(jsonb_typeof(facts)='object'),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 operation jsonb not null check(operation->>'id' is not distinct from 'MONTHLY_REVIEW'),
 contract jsonb not null check(jsonb_typeof(contract)='object'),
 created_at timestamptz not null default clock_timestamp(),
 deadline_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 unique(user_id,account_id,id),
 foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create index on public.monthly_ai_reviews(account_id,month_start,created_at desc,id desc);
create table public.monthly_ai_review_results (
 review_id uuid primary key, user_id uuid not null, account_id uuid not null,
 status text not null check(status in ('COMPLETED','FAILED')),
 interpretation jsonb, error_code text, raw_output jsonb,
 reservation_id uuid, created_at timestamptz not null default clock_timestamp(),
 check((status='COMPLETED' and interpretation is not null and jsonb_typeof(interpretation)='object' and error_code is null) or (status='FAILED' and interpretation is null and error_code is not null)),
 foreign key(user_id,account_id,review_id) references public.monthly_ai_reviews(user_id,account_id,id),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['monthly_ai_reviews','monthly_ai_review_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
create function public.start_monthly_ai_review(p_id uuid,p_user_id uuid,p_account_id uuid,p_month_start date,p_facts jsonb,p_hash text,p_operation jsonb,p_contract jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare existing public.monthly_ai_reviews; lower_bound timestamptz; upper_bound timestamptz; expected uuid[];
begin
 perform 1 from public.accounts where id=p_account_id and user_id=p_user_id for update;
 if not found then raise exception 'Account not found'; end if;
 select * into existing from public.monthly_ai_reviews where id=p_id;
 if found then
  if existing.user_id<>p_user_id or existing.account_id<>p_account_id or existing.month_start<>p_month_start then raise exception 'Review not found'; end if;
  return false;
 end if;
 lower_bound:=(p_month_start::timestamp+interval '5 hours') at time zone 'UTC';
 upper_bound:=(p_month_start::timestamp+interval '1 month 5 hours') at time zone 'UTC';
 if p_month_start is null or extract(day from p_month_start)<>1 or p_month_start<date '2000-01-01' or p_month_start>date '2099-12-01' or upper_bound>clock_timestamp() then raise exception 'A completed calendar month is required'; end if;
 select array(select p.id from public.trade_plans p join public.trade_outcomes o on o.plan_id=p.id and o.user_id=p.user_id and o.account_id=p.account_id where p.account_id=p_account_id and p.user_id=p_user_id and o.exited_at>=lower_bound and o.exited_at<upper_bound order by o.exited_at,p.id limit 121) into expected;
 if cardinality(expected)=0 or cardinality(expected)>120 then raise exception 'Monthly sample is empty or exceeds bounded limit'; end if;
 if p_facts->>'version' is distinct from 'MONTHLY_REVIEW_FACTS_V1'
  or p_facts->'period'->>'startDate' is distinct from p_month_start::text
  or (p_facts->'period'->>'start')::timestamptz is distinct from lower_bound
  or (p_facts->'period'->>'endExclusive')::timestamptz is distinct from upper_bound
  or p_facts->'sample'->>'count' is distinct from cardinality(expected)::text
  or p_facts->'sample'->'tradeIds' is distinct from to_jsonb(expected)
  or (select jsonb_agg(t->'tradeId' order by n) from jsonb_array_elements(p_facts->'trades') with ordinality as x(t,n)) is distinct from to_jsonb(expected)
 then raise exception 'Monthly scope or exact trade IDs mismatch; refresh'; end if;
 if exists(select 1 from public.monthly_ai_reviews r where r.account_id=p_account_id and r.month_start=p_month_start and r.deadline_at>clock_timestamp() and not exists(select 1 from public.monthly_ai_review_results x where x.review_id=r.id)) then raise exception 'Review already running'; end if;
 insert into public.monthly_ai_reviews(id,user_id,account_id,month_start,period_start,period_end_exclusive,trade_ids,sample_size,facts,input_hash,operation,contract)
 values(p_id,p_user_id,p_account_id,p_month_start,lower_bound,upper_bound,expected,cardinality(expected),p_facts,p_hash,p_operation,p_contract);
 return true;
end $$;
create function public.authorize_monthly_ai_review(p_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.monthly_ai_reviews r join public.accounts a on a.id=r.account_id and a.user_id=r.user_id where r.id=p_id and r.user_id=p_user_id and r.deadline_at>clock_timestamp() and not exists(select 1 from public.monthly_ai_review_results x where x.review_id=r.id)) then raise exception 'Review unavailable'; end if;
end $$;
create function public.finish_monthly_ai_review(p_id uuid,p_user_id uuid,p_status text,p_interpretation jsonb,p_error text,p_raw jsonb,p_reservation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.monthly_ai_reviews;
begin
 select * into r from public.monthly_ai_reviews where id=p_id and user_id=p_user_id for update;
 if not found then raise exception 'Review not found'; end if;
 if p_reservation_id is not null and not exists(select 1 from public.ai_request_reservations where id=p_reservation_id and user_id=r.user_id and account_id=r.account_id and operation_id=r.id and operation='MONTHLY_REVIEW') then raise exception 'Reservation mismatch'; end if;
 if p_status='COMPLETED' and not exists(select 1 from public.ai_usage_records where reservation_id=p_reservation_id and user_id=r.user_id and disposition='SETTLED') then raise exception 'Usage must be reconciled before completion'; end if;
 insert into public.monthly_ai_review_results(review_id,user_id,account_id,status,interpretation,error_code,raw_output,reservation_id)
 values(r.id,r.user_id,r.account_id,p_status,p_interpretation,p_error,p_raw,p_reservation_id);
end $$;
revoke all on function public.start_monthly_ai_review(uuid,uuid,uuid,date,jsonb,text,jsonb,jsonb),public.authorize_monthly_ai_review(uuid,uuid),public.finish_monthly_ai_review(uuid,uuid,text,jsonb,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.start_monthly_ai_review(uuid,uuid,uuid,date,jsonb,text,jsonb,jsonb),public.authorize_monthly_ai_review(uuid,uuid),public.finish_monthly_ai_review(uuid,uuid,text,jsonb,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
