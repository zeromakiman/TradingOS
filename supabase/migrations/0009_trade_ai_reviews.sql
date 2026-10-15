-- Additive advisory history only. Existing trade, risk, execution and screenshot rules are untouched.
create table public.trade_ai_reviews (
 id uuid primary key, user_id uuid not null, account_id uuid not null, plan_id uuid not null,
 facts jsonb not null check(jsonb_typeof(facts)='object'),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 operation jsonb not null check(operation->>'id' is not distinct from 'REVIEW_TRADE'),
 contract jsonb not null check(jsonb_typeof(contract)='object'),
 created_at timestamptz not null default clock_timestamp(),
 deadline_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 unique(user_id,account_id,id),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create index on public.trade_ai_reviews(plan_id,created_at desc);
create table public.trade_ai_review_results (
 review_id uuid primary key, user_id uuid not null, account_id uuid not null,
 status text not null check(status in ('COMPLETED','FAILED')),
 interpretation jsonb, error_code text, raw_output jsonb,
 reservation_id uuid, created_at timestamptz not null default clock_timestamp(),
 check((status='COMPLETED' and interpretation is not null and jsonb_typeof(interpretation)='object' and error_code is null) or (status='FAILED' and interpretation is null and error_code is not null)),
 foreign key(user_id,account_id,review_id) references public.trade_ai_reviews(user_id,account_id,id),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['trade_ai_reviews','trade_ai_review_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
create function public.start_trade_ai_review(p_id uuid,p_user_id uuid,p_plan_id uuid,p_facts jsonb,p_hash text,p_operation jsonb,p_contract jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.trade_plans; existing public.trade_ai_reviews;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=p_user_id for update;
 if not found then raise exception 'Trade not found'; end if;
 select * into existing from public.trade_ai_reviews where id=p_id;
 if found then
  if existing.user_id<>p_user_id or existing.plan_id<>p_plan_id then raise exception 'Review not found'; end if;
  return false; -- Replaying the same request can never spend again, including failed/incomplete attempts.
 end if;
 if not exists(select 1 from public.trade_outcomes where plan_id=p.id and user_id=p_user_id) then raise exception 'Close the trade before review'; end if;
 if exists(select 1 from public.trade_ai_reviews r where r.plan_id=p.id and r.deadline_at>clock_timestamp() and not exists(select 1 from public.trade_ai_review_results x where x.review_id=r.id)) then raise exception 'Review already running'; end if;
 insert into public.trade_ai_reviews(id,user_id,account_id,plan_id,facts,input_hash,operation,contract)
 values(p_id,p_user_id,p.account_id,p.id,p_facts,p_hash,p_operation,p_contract);
 return true;
end $$;
create function public.finish_trade_ai_review(p_id uuid,p_user_id uuid,p_status text,p_interpretation jsonb,p_error text,p_raw jsonb,p_reservation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.trade_ai_reviews;
begin
 select * into r from public.trade_ai_reviews where id=p_id and user_id=p_user_id for update;
 if not found then raise exception 'Review not found'; end if;
 if p_reservation_id is not null and not exists(select 1 from public.ai_request_reservations where id=p_reservation_id and user_id=r.user_id and account_id=r.account_id and operation_id=r.id and operation='REVIEW_TRADE') then raise exception 'Reservation mismatch'; end if;
 if p_status='COMPLETED' and not exists(select 1 from public.ai_usage_records where reservation_id=p_reservation_id and user_id=r.user_id and disposition='SETTLED') then raise exception 'Usage must be reconciled before completion'; end if;
 insert into public.trade_ai_review_results(review_id,user_id,account_id,status,interpretation,error_code,raw_output,reservation_id)
 values(r.id,r.user_id,r.account_id,p_status,p_interpretation,p_error,p_raw,p_reservation_id);
end $$;
revoke all on function public.start_trade_ai_review(uuid,uuid,uuid,jsonb,text,jsonb,jsonb),public.finish_trade_ai_review(uuid,uuid,text,jsonb,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.start_trade_ai_review(uuid,uuid,uuid,jsonb,text,jsonb,jsonb),public.finish_trade_ai_review(uuid,uuid,text,jsonb,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
