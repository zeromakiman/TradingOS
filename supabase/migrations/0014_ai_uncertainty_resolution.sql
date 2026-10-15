-- Explicit incident resolution only. Original reservation, usage and review history stay immutable.
-- No role membership is granted here. A DBA must provision a named operator separately.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='ai_accounting_operator') then
  create role ai_accounting_operator nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
end $$;

create table public.ai_uncertainty_resolutions (
 id uuid primary key,
 reservation_id uuid not null references public.ai_usage_records(reservation_id),
 user_id uuid not null, account_id uuid not null,
 decision text not null check(decision in ('NO_PROVIDER_USAGE_CONFIRMED','USAGE_CONFIRMED','KEEP_UNCERTAIN')),
 reason text not null check(length(btrim(reason)) between 10 and 4000),
 evidence_ref text not null check(length(btrim(evidence_ref)) between 3 and 1000),
 resolver text not null, created_at timestamptz not null default clock_timestamp(),
 original_charged_micros bigint not null check(original_charged_micros>=0),
 reconciled_micros bigint not null check(reconciled_micros>=0),
 released_micros bigint not null check(released_micros>=0),
 additional_micros bigint not null check(additional_micros>=0),
 details jsonb not null check(jsonb_typeof(details)='object'),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id),
 check(released_micros=greatest(original_charged_micros-reconciled_micros,0)),
 check(additional_micros=greatest(reconciled_micros-original_charged_micros,0)),
 check(decision<>'KEEP_UNCERTAIN' or reconciled_micros=original_charged_micros),
 check(decision<>'NO_PROVIDER_USAGE_CONFIRMED' or reconciled_micros=0)
);
create unique index ai_uncertainty_one_terminal on public.ai_uncertainty_resolutions(reservation_id) where decision<>'KEEP_UNCERTAIN';
create index on public.ai_uncertainty_resolutions(account_id,created_at);
alter table public.ai_uncertainty_resolutions enable row level security;
revoke all on public.ai_uncertainty_resolutions from public,anon,authenticated,service_role,ai_accounting_operator;
grant select on public.ai_uncertainty_resolutions to authenticated,ai_accounting_operator;
create policy owner_read on public.ai_uncertainty_resolutions for select to authenticated using(user_id=auth.uid());
create policy operator_read on public.ai_uncertainty_resolutions for select to ai_accounting_operator using(true);
create trigger immutable before update or delete on public.ai_uncertainty_resolutions for each row execute function private.reject_mutation();

-- Kept outside the PostgREST-exposed schema. No app/API endpoint or service-role grant.
-- Resolver comes from the authenticated database login, never an input/JWT claim.
create function private.resolve_ai_uncertainty(p_id uuid,p_reservation_id uuid,p_decision text,p_reason text,p_evidence_ref text,p_details jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.ai_request_reservations; u public.ai_usage_records; existing public.ai_uncertainty_resolutions; charge bigint;
begin
 if not pg_has_role(session_user,'ai_accounting_operator','MEMBER') then raise exception 'Accounting operator login required'; end if;
 if p_id is null or p_reservation_id is null or p_decision is null or p_decision not in ('NO_PROVIDER_USAGE_CONFIRMED','USAGE_CONFIRMED','KEEP_UNCERTAIN')
 or p_reason is null or length(btrim(p_reason)) not between 10 and 4000 or p_evidence_ref is null or length(btrim(p_evidence_ref)) not between 3 and 1000
 or p_details is null or jsonb_typeof(p_details)<>'object' or octet_length(p_details::text)>64000 then raise exception 'Explicit decision, reason and evidence required'; end if;
 select * into r from public.ai_request_reservations where id=p_reservation_id;
 if not found then raise exception 'Reservation not found'; end if;
 -- Same account lock used by reserve/dispatch/settle/preferences; no double-release race.
 perform 1 from public.accounts where id=r.account_id for update;
 select * into existing from public.ai_uncertainty_resolutions where id=p_id;
 if found then
  if existing.reservation_id=p_reservation_id and existing.decision=p_decision and existing.reason=p_reason and existing.evidence_ref=p_evidence_ref
  and existing.details=p_details and existing.resolver=session_user then return existing.id; end if;
  raise exception 'Resolution id conflicts with an existing decision';
 end if;
 select * into u from public.ai_usage_records where reservation_id=r.id;
 if not found or u.disposition<>'UNCERTAIN' then raise exception 'Reservation is not uncertain'; end if;
 if exists(select 1 from public.ai_uncertainty_resolutions where reservation_id=r.id and decision<>'KEEP_UNCERTAIN') then raise exception 'Uncertainty already resolved'; end if;
 charge:=u.charged_micros;
 if p_decision='USAGE_CONFIRMED' then
  -- Trusted operator attests a known cost, never a normal user/browser estimate.
  -- A usage estimate must be derived from the reservation's preserved pricing, not today's rates.
  if p_details->>'costBasis' is null or p_details->>'costBasis' not in ('PROVIDER_BILLED_EUR','PROVIDER_BILLED_USD','PROVIDER_USAGE_ESTIMATE')
   or coalesce(p_details->>'chargedMicros','') !~ '^[0-9]{1,12}$'
   or length(btrim(coalesce(p_details->>'providerReference',''))) not between 3 and 1000 then raise exception 'Confirmed cost and provider evidence required'; end if;
  charge:=(p_details->>'chargedMicros')::bigint;
  if p_details->>'costBasis'='PROVIDER_BILLED_USD' then
   if coalesce(p_details->>'billedUsd','') !~ '^[0-9]{1,6}(\.[0-9]{1,9})?$'
    or coalesce(r.pricing->>'usdCostToEurBudgetMultiplier','') !~ '^[0-9]{1,3}(\.[0-9]{1,9})?$'
    or (r.pricing->>'usdCostToEurBudgetMultiplier')::numeric<=0 then raise exception 'Preserved conversion and confirmed USD amount required'; end if;
   if charge<>ceil((p_details->>'billedUsd')::numeric*(r.pricing->>'usdCostToEurBudgetMultiplier')::numeric*1000000) then raise exception 'Confirmed USD conversion mismatch'; end if;
  end if;
  if p_details->>'costBasis'='PROVIDER_USAGE_ESTIMATE' then
   if jsonb_typeof(p_details->'usage') is distinct from 'object'
    or coalesce(p_details->'usage'->>'input_tokens','') !~ '^[0-9]{1,9}$'
    or coalesce(p_details->'usage'->>'output_tokens','') !~ '^[0-9]{1,9}$'
    or length(btrim(coalesce(p_details->>'responseModel','')))=0 then raise exception 'Provider usage and model required for estimated cost'; end if;
  end if;
 else
  if p_details<>'{}'::jsonb then raise exception 'No cost payload permitted for this decision'; end if;
  if p_decision='NO_PROVIDER_USAGE_CONFIRMED' then charge:=0; end if;
 end if;
 insert into public.ai_uncertainty_resolutions(id,reservation_id,user_id,account_id,decision,reason,evidence_ref,resolver,original_charged_micros,reconciled_micros,released_micros,additional_micros,details)
 values(p_id,r.id,r.user_id,r.account_id,p_decision,p_reason,p_evidence_ref,session_user,u.charged_micros,charge,greatest(u.charged_micros-charge,0),greatest(charge-u.charged_micros,0),p_details);
 return p_id;
end $$;
revoke all on function private.resolve_ai_uncertainty(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant usage on schema private,public to ai_accounting_operator;
grant execute on function private.resolve_ai_uncertainty(uuid,uuid,text,text,text,jsonb) to ai_accounting_operator;

-- Effective budget overlay, attributed to the ORIGINAL reservation month.
-- KEEP decisions do not clear the all-period uncertainty block. No historical row is rewritten.
create or replace function private.ai_budget_snapshot(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare opt boolean; cap integer; used bigint; held bigint; uncertain boolean; month date:=private.ai_month(clock_timestamp());
begin
 select enabled,budget_cents into opt,cap from public.ai_preference_events where account_id=p_account_id order by id desc limit 1;
 select coalesce(sum(coalesce(x.reconciled_micros,u.charged_micros,0)),0),coalesce(sum(case when u.reservation_id is null then r.reserved_micros else 0 end),0)
 into used,held from public.ai_request_reservations r
 left join public.ai_usage_records u on u.reservation_id=r.id
 left join public.ai_uncertainty_resolutions x on x.reservation_id=r.id and x.decision<>'KEEP_UNCERTAIN'
 where r.account_id=p_account_id and r.period=month;
 select exists(select 1 from public.ai_usage_records u where u.account_id=p_account_id and u.disposition='UNCERTAIN'
 and not exists(select 1 from public.ai_uncertainty_resolutions x where x.reservation_id=u.reservation_id and x.decision<>'KEEP_UNCERTAIN')) into uncertain;
 return jsonb_build_object('enabled',coalesce(opt,false),'budgetCents',coalesce(cap,500),'usedMicros',used,'heldMicros',held,'uncertain',uncertain,'period',month,
 'resetAt',((month+interval '1 month'+interval '5 hours') at time zone 'UTC'));
end $$;
notify pgrst,'reload schema';
