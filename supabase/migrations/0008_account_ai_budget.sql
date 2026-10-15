-- Optional AI only. No existing trade, risk, evidence or evaluation record is changed.
-- Money uses integer EUR millionths; all history is append-only.
create function private.ai_month(p_now timestamptz) returns date language sql immutable set search_path='' as $$
 select date_trunc('month',p_now at time zone 'UTC' - interval '5 hours')::date
$$;

create table public.ai_preference_events (
 id bigint generated always as identity primary key,
 user_id uuid not null, account_id uuid not null,
 previous_enabled boolean not null, enabled boolean not null,
 previous_budget_cents integer not null, budget_cents integer not null check(budget_cents between 100 and 10000),
 consent_version text, created_at timestamptz not null default clock_timestamp(),
 check(not enabled or consent_version='AI_DISCLOSURE_V1'),
 foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create index on public.ai_preference_events(account_id,id desc);
create table public.ai_request_reservations (
 id uuid primary key, user_id uuid not null, account_id uuid not null,
 operation text not null check(operation ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 operation_id uuid not null, stage text not null check(stage in ('A','B','RECONCILER')),
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
 provider text not null check(provider ~ '^[a-z][a-z0-9_-]{0,63}$'), model text not null,
 pricing jsonb not null check(jsonb_typeof(pricing)='object'),
 reserved_micros bigint not null check(reserved_micros>0 and reserved_micros<=100000000),
 period date not null, created_at timestamptz not null default clock_timestamp(),
 unique(user_id,account_id,id), unique(operation_id,stage),
 foreign key(user_id,account_id) references public.accounts(user_id,id)
);
create index on public.ai_request_reservations(account_id,period);
create table public.ai_request_dispatches (
 reservation_id uuid primary key, user_id uuid not null, account_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
create table public.ai_usage_records (
 reservation_id uuid primary key, user_id uuid not null, account_id uuid not null,
 disposition text not null check(disposition in ('SETTLED','UNCERTAIN','CANCELLED')),
 charged_micros bigint not null check(charged_micros>=0),
 input_tokens bigint, output_tokens bigint, cached_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint,
 usage jsonb, response_id text, response_model text, error_code text,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
create index on public.ai_usage_records(account_id) where disposition='UNCERTAIN';

do $$ declare t text; begin
 foreach t in array array['ai_preference_events','ai_request_reservations','ai_request_dispatches','ai_usage_records'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
revoke all on sequence public.ai_preference_events_id_seq from public,anon,authenticated,service_role;

create function public.set_account_ai_preferences(p_account_id uuid,p_enabled boolean,p_budget_cents integer,p_confirm boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare old_enabled boolean; old_budget integer;
begin
 perform 1 from public.accounts where id=p_account_id and user_id=auth.uid() for update;
 if not found then raise exception 'Account not found'; end if;
 select enabled,budget_cents into old_enabled,old_budget from public.ai_preference_events where account_id=p_account_id order by id desc limit 1;
 old_enabled:=coalesce(old_enabled,false); old_budget:=coalesce(old_budget,500);
 p_enabled:=coalesce(p_enabled,old_enabled); p_budget_cents:=coalesce(p_budget_cents,old_budget);
 if p_budget_cents not between 100 and 10000 then raise exception 'Budget must be EUR 1 to 100'; end if;
 if p_enabled and not old_enabled and p_confirm is distinct from true then raise exception 'Explicit AI disclosure confirmation required'; end if;
 if old_enabled=p_enabled and old_budget=p_budget_cents then return; end if;
 insert into public.ai_preference_events(user_id,account_id,previous_enabled,enabled,previous_budget_cents,budget_cents,consent_version)
 values(auth.uid(),p_account_id,old_enabled,p_enabled,old_budget,p_budget_cents,case when p_enabled then 'AI_DISCLOSURE_V1' else null end);
end $$;

create function private.ai_budget_snapshot(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare opt boolean; cap integer; used bigint; held bigint; uncertain boolean; month date:=private.ai_month(clock_timestamp());
begin
 select enabled,budget_cents into opt,cap from public.ai_preference_events where account_id=p_account_id order by id desc limit 1;
 select coalesce(sum(u.charged_micros),0),coalesce(sum(case when u.reservation_id is null then r.reserved_micros else 0 end),0)
 into used,held from public.ai_request_reservations r left join public.ai_usage_records u on u.reservation_id=r.id where r.account_id=p_account_id and r.period=month;
 select exists(select 1 from public.ai_usage_records where account_id=p_account_id and disposition='UNCERTAIN') into uncertain;
 return jsonb_build_object('enabled',coalesce(opt,false),'budgetCents',coalesce(cap,500),'usedMicros',used,'heldMicros',held,'uncertain',uncertain,'period',month,
 'resetAt',((month+interval '1 month'+interval '5 hours') at time zone 'UTC'));
end $$;
create function public.get_account_ai_budget(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.accounts where id=p_account_id and user_id=auth.uid()) then raise exception 'Account not found'; end if;
 return private.ai_budget_snapshot(p_account_id);
end $$;

-- Trusted server ONLY. Ownership is rechecked here even after session-scoped loading.
create function public.reserve_account_ai_request(p_id uuid,p_user_id uuid,p_account_id uuid,p_operation_id uuid,p_stage text,p_request_hash text,p_model text,p_pricing jsonb,p_reserved_micros bigint,p_operation text,p_provider text)
returns void language plpgsql security definer set search_path='' as $$
declare state jsonb;
begin
 perform 1 from public.accounts where id=p_account_id and user_id=p_user_id for update;
 if not found then raise exception 'Account not found'; end if;
 state:=private.ai_budget_snapshot(p_account_id);
 if (state->>'uncertain')::boolean then raise exception 'AI accounting requires review'; end if;
 if not (state->>'enabled')::boolean then raise exception 'Account AI is OFF'; end if;
 if p_reserved_micros is null or p_reserved_micros<=0 or (state->>'usedMicros')::bigint+(state->>'heldMicros')::bigint+p_reserved_micros>(state->>'budgetCents')::bigint*10000 then raise exception 'Insufficient AI budget for reservation'; end if;
 insert into public.ai_request_reservations(id,user_id,account_id,operation,operation_id,stage,request_hash,provider,model,pricing,reserved_micros,period)
 values(p_id,p_user_id,p_account_id,p_operation,p_operation_id,p_stage,p_request_hash,p_provider,p_model,p_pricing,p_reserved_micros,(state->>'period')::date);
end $$;

-- Single-use dispatch authorization. Recheck opt-out, lower cap and month boundary.
create function public.dispatch_account_ai_request(p_id uuid,p_user_id uuid,p_request_hash text,p_recheck boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare r public.ai_request_reservations; state jsonb;
begin
 select * into r from public.ai_request_reservations where id=p_id and user_id=p_user_id;
 if not found then raise exception 'Reservation not found'; end if;
 perform 1 from public.accounts where id=r.account_id for update;
 state:=private.ai_budget_snapshot(r.account_id);
 if r.request_hash<>p_request_hash or r.period<>(state->>'period')::date or exists(select 1 from public.ai_usage_records where reservation_id=r.id)
 or (state->>'uncertain')::boolean or not (state->>'enabled')::boolean
 or (state->>'usedMicros')::bigint+(state->>'heldMicros')::bigint>(state->>'budgetCents')::bigint*10000 then raise exception 'AI permission or budget changed'; end if;
 if p_recheck then
  if not exists(select 1 from public.ai_request_dispatches where reservation_id=r.id) then raise exception 'Request not dispatched'; end if;
 else
  insert into public.ai_request_dispatches(reservation_id,user_id,account_id) values(r.id,r.user_id,r.account_id);
 end if;
end $$;

create function public.settle_account_ai_request(p_id uuid,p_user_id uuid,p_record jsonb) returns void language plpgsql security definer set search_path='' as $$
declare r public.ai_request_reservations; dispatched boolean; kind text:=p_record->>'disposition'; charge bigint:=(p_record->>'chargedMicros')::bigint;
begin
 select * into r from public.ai_request_reservations where id=p_id and user_id=p_user_id;
 if not found then raise exception 'Reservation not found'; end if;
 perform 1 from public.accounts where id=r.account_id for update;
 if exists(select 1 from public.ai_usage_records where reservation_id=r.id) then raise exception 'Already reconciled'; end if;
 select exists(select 1 from public.ai_request_dispatches where reservation_id=r.id) into dispatched;
 if kind is null or kind not in ('SETTLED','UNCERTAIN','CANCELLED') or charge is null or charge<0 then raise exception 'Invalid accounting record'; end if;
 if kind='CANCELLED' and (dispatched or charge<>0) then raise exception 'Dispatched requests cannot be refunded without usage'; end if;
 if kind<>'CANCELLED' and not dispatched then raise exception 'Request was not dispatched'; end if;
 if kind='SETTLED' and (charge>r.reserved_micros or p_record->'usage' is null or p_record->>'inputTokens' is null or p_record->>'outputTokens' is null) then raise exception 'Invalid settlement'; end if;
 if kind='UNCERTAIN' and charge<r.reserved_micros then raise exception 'Uncertain requests retain full reservation'; end if;
 insert into public.ai_usage_records(reservation_id,user_id,account_id,disposition,charged_micros,input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,usage,response_id,response_model,error_code)
 values(r.id,r.user_id,r.account_id,kind,charge,(p_record->>'inputTokens')::bigint,(p_record->>'outputTokens')::bigint,(p_record->>'cachedTokens')::bigint,(p_record->>'cacheWriteTokens')::bigint,(p_record->>'reasoningTokens')::bigint,p_record->'usage',p_record->>'responseId',p_record->>'responseModel',p_record->>'errorCode');
end $$;

revoke all on function private.ai_month(timestamptz),private.ai_budget_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_account_ai_budget(uuid),public.set_account_ai_preferences(uuid,boolean,integer,boolean) from public,anon,service_role;
grant execute on function public.get_account_ai_budget(uuid),public.set_account_ai_preferences(uuid,boolean,integer,boolean) to authenticated;
revoke all on function public.reserve_account_ai_request(uuid,uuid,uuid,uuid,text,text,text,jsonb,bigint,text,text),public.dispatch_account_ai_request(uuid,uuid,text,boolean),public.settle_account_ai_request(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_account_ai_request(uuid,uuid,uuid,uuid,text,text,text,jsonb,bigint,text,text),public.dispatch_account_ai_request(uuid,uuid,text,boolean),public.settle_account_ai_request(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
