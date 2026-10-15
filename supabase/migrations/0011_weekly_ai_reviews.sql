-- Account/week history cannot use the plan/proposal-only foreign keys in 0009/0010.
-- Additive advisory tables and service-only RPCs; no trade, risk or accounting changes.
create table public.weekly_ai_reviews (
 id uuid primary key, user_id uuid not null, account_id uuid not null,
 week_start date not null check(extract(isodow from week_start)=1),
 facts jsonb not null check(jsonb_typeof(facts)='object'),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 operation jsonb not null check(operation->>'id' is not distinct from 'WEEKLY_REVIEW'),
 contract jsonb not null check(jsonb_typeof(contract)='object'),
 created_at timestamptz not null default clock_timestamp(),
 deadline_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 unique(user_id,account_id,id),
 foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create index on public.weekly_ai_reviews(account_id,week_start,created_at desc,id desc);
create table public.weekly_ai_review_results (
 review_id uuid primary key, user_id uuid not null, account_id uuid not null,
 status text not null check(status in ('COMPLETED','FAILED')),
 interpretation jsonb, error_code text, raw_output jsonb,
 reservation_id uuid, created_at timestamptz not null default clock_timestamp(),
 check((status='COMPLETED' and interpretation is not null and jsonb_typeof(interpretation)='object' and error_code is null) or (status='FAILED' and interpretation is null and error_code is not null)),
 foreign key(user_id,account_id,review_id) references public.weekly_ai_reviews(user_id,account_id,id),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['weekly_ai_reviews','weekly_ai_review_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
create function public.start_weekly_ai_review(p_id uuid,p_user_id uuid,p_account_id uuid,p_week_start date,p_facts jsonb,p_hash text,p_operation jsonb,p_contract jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare existing public.weekly_ai_reviews;
begin
 perform 1 from public.accounts where id=p_account_id and user_id=p_user_id for update;
 if not found then raise exception 'Account not found'; end if;
 select * into existing from public.weekly_ai_reviews where id=p_id;
 if found then
  if existing.user_id<>p_user_id or existing.account_id<>p_account_id or existing.week_start<>p_week_start then raise exception 'Review not found'; end if;
  return false;
 end if;
 if p_week_start is null or extract(isodow from p_week_start)<>1 or ((p_week_start+7)::timestamp+interval '5 hours') at time zone 'UTC'>clock_timestamp() then raise exception 'A completed Monday week is required'; end if;
 if p_facts->'period'->>'startDate' is distinct from p_week_start::text or p_facts->>'version' is distinct from 'WEEKLY_REVIEW_FACTS_V1' then raise exception 'Weekly scope mismatch'; end if;
 if exists(select 1 from public.weekly_ai_reviews r where r.account_id=p_account_id and r.week_start=p_week_start and r.deadline_at>clock_timestamp() and not exists(select 1 from public.weekly_ai_review_results x where x.review_id=r.id)) then raise exception 'Review already running'; end if;
 insert into public.weekly_ai_reviews(id,user_id,account_id,week_start,facts,input_hash,operation,contract)
 values(p_id,p_user_id,p_account_id,p_week_start,p_facts,p_hash,p_operation,p_contract);
 return true;
end $$;
create function public.authorize_weekly_ai_review(p_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.weekly_ai_reviews r join public.accounts a on a.id=r.account_id and a.user_id=r.user_id where r.id=p_id and r.user_id=p_user_id and r.deadline_at>clock_timestamp() and not exists(select 1 from public.weekly_ai_review_results x where x.review_id=r.id)) then raise exception 'Review unavailable'; end if;
end $$;
create function public.finish_weekly_ai_review(p_id uuid,p_user_id uuid,p_status text,p_interpretation jsonb,p_error text,p_raw jsonb,p_reservation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.weekly_ai_reviews;
begin
 select * into r from public.weekly_ai_reviews where id=p_id and user_id=p_user_id for update;
 if not found then raise exception 'Review not found'; end if;
 if p_reservation_id is not null and not exists(select 1 from public.ai_request_reservations where id=p_reservation_id and user_id=r.user_id and account_id=r.account_id and operation_id=r.id and operation='WEEKLY_REVIEW') then raise exception 'Reservation mismatch'; end if;
 if p_status='COMPLETED' and not exists(select 1 from public.ai_usage_records where reservation_id=p_reservation_id and user_id=r.user_id and disposition='SETTLED') then raise exception 'Usage must be reconciled before completion'; end if;
 insert into public.weekly_ai_review_results(review_id,user_id,account_id,status,interpretation,error_code,raw_output,reservation_id)
 values(r.id,r.user_id,r.account_id,p_status,p_interpretation,p_error,p_raw,p_reservation_id);
end $$;
revoke all on function public.start_weekly_ai_review(uuid,uuid,uuid,date,jsonb,text,jsonb,jsonb),public.authorize_weekly_ai_review(uuid,uuid),public.finish_weekly_ai_review(uuid,uuid,text,jsonb,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.start_weekly_ai_review(uuid,uuid,uuid,date,jsonb,text,jsonb,jsonb),public.authorize_weekly_ai_review(uuid,uuid),public.finish_weekly_ai_review(uuid,uuid,text,jsonb,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
