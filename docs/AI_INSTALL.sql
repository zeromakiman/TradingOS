-- Trading OS AI phase: run this complete file in this project's SQL editor.
-- Atomic, additive installation. Existing migration history is never rewritten.
begin;
do $guard$ begin if exists(select 1 from supabase_migrations.schema_migrations where version='0004') then raise exception 'Migration 0004 already applied; stop and inspect history'; end if; end $guard$;
-- Additive screenshot/AI layer. Existing locked plans and evaluator contracts remain immutable.
create table public.setup_proposals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
 strategy_version_id uuid not null, instrument_version_id uuid not null, risk_evaluation_id uuid not null,
 proposal jsonb not null check(jsonb_typeof(proposal)='object'), request_key uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(user_id,account_id,id), unique(user_id,account_id,id,strategy_version_id), unique(user_id,request_key),
 foreign key(user_id,account_id) references public.accounts(user_id,id),
 foreign key(user_id,account_id,strategy_version_id) references public.strategy_versions(user_id,account_id,id),
 foreign key(user_id,account_id,instrument_version_id) references public.instrument_versions(user_id,account_id,id),
 foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id)
);
create table public.setup_locks (
 proposal_id uuid primary key, user_id uuid not null, account_id uuid not null, plan_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create table public.setup_risk_checks (
 id bigint generated always as identity primary key, user_id uuid not null, account_id uuid not null,
 proposal_id uuid not null, risk_evaluation_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id),
 foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id)
);
create table public.setup_screenshots (
 id uuid primary key, user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 role text not null check(role in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER')),
 storage_path text not null unique, original_filename text not null check(length(original_filename) between 1 and 255),
 mime_type text not null check(mime_type in ('image/png','image/jpeg','image/webp')),
 byte_size integer not null check(byte_size between 1 and 10485760), sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 width integer not null check(width>0), height integer not null check(height>0),
 uploaded_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,proposal_id,id),
 check(width::bigint*height<=40000000),
 check(storage_path=user_id::text||'/'||proposal_id::text||'/'||id::text),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id)
);
create table public.setup_screenshot_removals (
 screenshot_id uuid primary key references public.setup_screenshots(id), user_id uuid not null, account_id uuid not null,
 proposal_id uuid not null, recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id,screenshot_id) references public.setup_screenshots(user_id,account_id,proposal_id,id)
);
create table public.evaluator_versions (
 version text primary key, schema_version text not null, system_prompt text not null, json_schema jsonb not null,
 config jsonb not null, sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default clock_timestamp()
);
create table public.setup_evaluations (
 id uuid primary key, user_id uuid not null, account_id uuid not null, proposal_id uuid not null, strategy_version_id uuid not null,
 evaluator_version text not null references public.evaluator_versions(version), mode text not null check(mode in ('NORMAL','DEEP')),
 model text not null, manifest jsonb not null, input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(), deadline_at timestamptz not null,
 unique(user_id,account_id,id),
 check(deadline_at>created_at and deadline_at<created_at+interval '30 minutes'),
 foreign key(user_id,account_id,proposal_id,strategy_version_id) references public.setup_proposals(user_id,account_id,id,strategy_version_id)
);
create table public.setup_evaluation_screenshots (
 evaluation_id uuid not null, screenshot_id uuid not null, user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 primary key(evaluation_id,screenshot_id),
 foreign key(user_id,account_id,evaluation_id) references public.setup_evaluations(user_id,account_id,id),
 foreign key(user_id,account_id,proposal_id,screenshot_id) references public.setup_screenshots(user_id,account_id,proposal_id,id)
);
create table public.setup_evaluation_events (
 id bigint generated always as identity primary key, user_id uuid not null, account_id uuid not null, evaluation_id uuid not null,
 status text not null check(status in ('QUEUED','RUNNING','COMPLETED','FAILED')), payload jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp(), unique(evaluation_id,status),
 foreign key(user_id,account_id,evaluation_id) references public.setup_evaluations(user_id,account_id,id)
);
create table public.setup_evaluation_passes (
 id uuid primary key, user_id uuid not null, account_id uuid not null, evaluation_id uuid not null,
 stage text not null check(stage in ('A','B','RECONCILER')), status text not null check(status in ('VALID','INVALID','REFUSED','INCOMPLETE','FAILED')),
 model text not null, response_id text, output jsonb, usage jsonb, error_code text,
 created_at timestamptz not null default clock_timestamp(), unique(evaluation_id,stage),
 check(status<>'VALID' or output is not null),
 foreign key(user_id,account_id,evaluation_id) references public.setup_evaluations(user_id,account_id,id)
);
create table public.setup_human_decisions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 decision text not null check(decision in ('TAKEN','SKIPPED')), event_type text not null check(event_type in ('HUMAN_DECISION','MANUAL_OVERRIDE')),
 reason text check(length(reason)<=5000), risk_evaluation_id uuid not null, ai_evaluation_id uuid,
 ai_decision text not null, ai_context_status text not null, risk_decision text not null check(risk_decision in ('APPROVED','BLOCKED')),
 recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id),
 foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id),
 foreign key(user_id,account_id,ai_evaluation_id) references public.setup_evaluations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['setup_proposals','setup_locks','setup_risk_checks','setup_screenshots','setup_screenshot_removals','setup_evaluations','setup_evaluation_screenshots','setup_evaluation_events','setup_evaluation_passes','setup_human_decisions'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant select,insert on public.%I to service_role',t);
 execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
alter table public.evaluator_versions enable row level security;
create policy authenticated_read on public.evaluator_versions for select to authenticated using (true);
revoke all on public.evaluator_versions from anon,authenticated;
grant select on public.evaluator_versions to authenticated;
grant select,insert on public.evaluator_versions to service_role;
create trigger immutable before update or delete on public.evaluator_versions for each row execute function private.reject_mutation();
grant usage,select on sequence public.setup_risk_checks_id_seq,public.setup_evaluation_events_id_seq to service_role;
create index on public.setup_proposals(account_id,created_at desc);
create index on public.setup_evaluations(proposal_id,created_at desc);
create index on public.setup_evaluation_events(evaluation_id,id desc);
create index on public.setup_screenshots(proposal_id);

create function public.save_setup_proposal(p_account_id uuid,p_proposal jsonb,p_key uuid,p_expected_risk_id uuid,p_expected_observation_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.setup_proposals; result jsonb; rid uuid; sid uuid; iid uuid;
begin
 perform 1 from public.accounts where id=p_account_id and user_id=auth.uid() for update;
 if not found or p_key is null then raise exception 'Account not found or missing request key'; end if;
 select * into v from public.setup_proposals where user_id=auth.uid() and request_key=p_key;
 if found then
   if v.account_id<>p_account_id or v.proposal is distinct from p_proposal then raise exception 'Idempotency conflict'; end if;
   return v.id;
 end if;
 result:=public.evaluate_trade_plan(p_account_id,p_proposal,p_expected_risk_id,p_expected_observation_id);
 rid:=(result->>'evaluationId')::uuid;
 select strategy_version_id,instrument_version_id into sid,iid from public.risk_evaluations where id=rid;
 if result->'result'->'issues' @> '[{"code":"INVALID_INPUT"}]'::jsonb then raise exception 'Invalid proposal'; end if;
 insert into public.setup_proposals(user_id,account_id,strategy_version_id,instrument_version_id,risk_evaluation_id,proposal,request_key)
 values(auth.uid(),p_account_id,sid,iid,rid,p_proposal,p_key) returning * into v;
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,rid);
 return v.id;
end $$;
create function public.import_locked_setup(p_plan_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.trade_plans; v uuid;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid();
 if not found then raise exception 'Plan not found'; end if;
 perform 1 from public.accounts where id=p.account_id for update;
 select proposal_id into v from public.setup_locks where plan_id=p.id;
 if found then return v; end if;
 insert into public.setup_proposals(user_id,account_id,strategy_version_id,instrument_version_id,risk_evaluation_id,proposal,request_key)
 values(p.user_id,p.account_id,p.strategy_version_id,p.instrument_version_id,p.risk_evaluation_id,p.proposal,p.id) returning id into v;
 insert into public.setup_locks(user_id,account_id,proposal_id,plan_id) values(p.user_id,p.account_id,v,p.id);
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(p.user_id,p.account_id,v,p.risk_evaluation_id);
 return v;
end $$;
create function public.check_setup_risk(p_proposal_id uuid,p_lock boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
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
create function public.remove_setup_screenshot(p_screenshot_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.setup_screenshots;
begin
 select * into s from public.setup_screenshots where id=p_screenshot_id and user_id=auth.uid();
 if not found then raise exception 'Screenshot not found'; end if;
 perform 1 from public.setup_proposals where id=s.proposal_id for update;
 insert into public.setup_screenshot_removals(screenshot_id,user_id,account_id,proposal_id) values(s.id,s.user_id,s.account_id,s.proposal_id) on conflict do nothing;
end $$;

-- Only the trusted server can persist provider results. No authenticated RPC can forge an AI verdict.
create function public.start_setup_evaluation(p_record jsonb,p_screenshots uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare v public.setup_proposals; eid uuid:=(p_record->>'id')::uuid; n integer;
begin
 select * into v from public.setup_proposals where id=(p_record->>'proposal_id')::uuid and user_id=(p_record->>'user_id')::uuid for update;
 if not found then raise exception 'Proposal not found'; end if;
 if exists(select 1 from public.setup_evaluations where id=eid) then raise exception 'Request already exists'; end if;
 -- Expired jobs are append-only failures; no result can later turn them into a success.
 insert into public.setup_evaluation_events(user_id,account_id,evaluation_id,status,payload)
 select e.user_id,e.account_id,e.id,'FAILED','{"error":"WORKER_TIMEOUT"}'::jsonb from public.setup_evaluations e
 where e.proposal_id=v.id and e.deadline_at<clock_timestamp() and not exists(select 1 from public.setup_evaluation_events x where x.evaluation_id=e.id and x.status in ('COMPLETED','FAILED'));
 if exists(select 1 from public.setup_evaluations e where e.proposal_id=v.id and not exists(select 1 from public.setup_evaluation_events x where x.evaluation_id=e.id and x.status in ('COMPLETED','FAILED'))) then raise exception 'An evaluation is already running'; end if;
 select count(*) into n from public.setup_screenshots s where s.id=any(p_screenshots) and s.proposal_id=v.id and s.user_id=v.user_id and not exists(select 1 from public.setup_screenshot_removals x where x.screenshot_id=s.id);
 if n<1 or n>8 or n<>cardinality(p_screenshots) then raise exception 'Invalid screenshot selection'; end if;
 if (select sum(byte_size) from public.setup_screenshots where id=any(p_screenshots))>41943040 then raise exception 'Screenshot batch exceeds 40 MB'; end if;
 insert into public.setup_evaluations(id,user_id,account_id,proposal_id,strategy_version_id,evaluator_version,mode,model,manifest,input_hash,deadline_at)
 values(eid,v.user_id,v.account_id,v.id,v.strategy_version_id,p_record->>'evaluator_version',p_record->>'mode',p_record->>'model',p_record->'manifest',p_record->>'input_hash',(p_record->>'deadline_at')::timestamptz);
 insert into public.setup_evaluation_screenshots(evaluation_id,screenshot_id,user_id,account_id,proposal_id) select eid,id,v.user_id,v.account_id,v.id from public.setup_screenshots where id=any(p_screenshots);
 insert into public.setup_evaluation_events(user_id,account_id,evaluation_id,status) values(v.user_id,v.account_id,eid,'QUEUED'),(v.user_id,v.account_id,eid,'RUNNING');
 return eid;
end $$;
create function public.finish_setup_evaluation(p_id uuid,p_status text,p_payload jsonb) returns void language plpgsql security definer set search_path='' as $$
declare e public.setup_evaluations;
begin
 select * into e from public.setup_evaluations where id=p_id for update;
 if not found or p_status not in ('COMPLETED','FAILED') then raise exception 'Invalid completion'; end if;
 if exists(select 1 from public.setup_evaluation_events where evaluation_id=e.id and status in ('COMPLETED','FAILED')) then raise exception 'Evaluation is already terminal'; end if;
 if e.deadline_at<clock_timestamp() then p_status:='FAILED'; p_payload:='{"error":"WORKER_TIMEOUT"}'::jsonb; end if;
 if p_status='COMPLETED' and (p_payload#>>'{result,decision}' is null or p_payload#>>'{result,decision}' not in ('APPROVED','CONDITIONAL','BLOCKED','INSUFFICIENT_EVIDENCE') or not exists(select 1 from public.setup_evaluation_passes where evaluation_id=e.id and status='VALID' and stage=case when e.mode='DEEP' then 'RECONCILER' else 'A' end)) then raise exception 'Missing validated result'; end if;
 insert into public.setup_evaluation_events(user_id,account_id,evaluation_id,status,payload) values(e.user_id,e.account_id,e.id,p_status,p_payload);
end $$;
create function public.record_setup_decision(p_proposal_id uuid,p_decision text,p_reason text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare v public.setup_proposals; risk jsonb; ai uuid; verdict text; event text; result_id uuid; context_status text;
begin
 select * into v from public.setup_proposals where id=p_proposal_id and user_id=auth.uid();
 if not found or p_decision is null or p_decision not in ('TAKEN','SKIPPED') or length(p_reason)>5000 then raise exception 'Invalid decision or proposal'; end if;
 perform 1 from public.accounts where id=v.account_id for update;
 risk:=public.check_setup_risk(v.id,false);
 select e.id into ai from public.setup_evaluations e where e.proposal_id=v.id and exists(select 1 from public.setup_evaluation_events x where x.evaluation_id=e.id and x.status='COMPLETED') order by e.created_at desc,e.id desc limit 1;
 select payload#>>'{result,decision}' into verdict from public.setup_evaluation_events where evaluation_id=ai and status='COMPLETED';
 verdict:=coalesce(verdict,'NOT_EVALUATED');
 context_status:=case when ai is null then 'NOT_EVALUATED' else 'CURRENT' end;
 if ai is not null and exists(
   (select s.id from public.setup_screenshots s where s.proposal_id=v.id and not exists(select 1 from public.setup_screenshot_removals r where r.screenshot_id=s.id) except select screenshot_id from public.setup_evaluation_screenshots where evaluation_id=ai)
   union all
   (select screenshot_id from public.setup_evaluation_screenshots where evaluation_id=ai except select s.id from public.setup_screenshots s where s.proposal_id=v.id and not exists(select 1 from public.setup_screenshot_removals r where r.screenshot_id=s.id))
 ) then context_status:='EVIDENCE_CHANGED'; end if;
 if ai is not null and ai<>(select id from public.setup_evaluations where proposal_id=v.id order by created_at desc,id desc limit 1) then context_status:='NEWER_REVIEW_NOT_COMPLETED'; end if;
 event:=case when p_decision='TAKEN' and (verdict='BLOCKED' or risk#>>'{result,decision}'='BLOCKED') then 'MANUAL_OVERRIDE' else 'HUMAN_DECISION' end;
 insert into public.setup_human_decisions(user_id,account_id,proposal_id,decision,event_type,reason,risk_evaluation_id,ai_evaluation_id,ai_decision,ai_context_status,risk_decision)
 values(v.user_id,v.account_id,v.id,p_decision,event,p_reason,(risk->>'evaluationId')::uuid,ai,verdict,context_status,risk#>>'{result,decision}') returning id into result_id;
 return result_id;
end $$;
revoke all on function public.save_setup_proposal(uuid,jsonb,uuid,uuid,uuid),public.import_locked_setup(uuid),public.check_setup_risk(uuid,boolean),public.remove_setup_screenshot(uuid),public.record_setup_decision(uuid,text,text) from public,anon;
grant execute on function public.save_setup_proposal(uuid,jsonb,uuid,uuid,uuid),public.import_locked_setup(uuid),public.check_setup_risk(uuid,boolean),public.remove_setup_screenshot(uuid),public.record_setup_decision(uuid,text,text) to authenticated;
revoke all on function public.start_setup_evaluation(jsonb,uuid[]),public.finish_setup_evaluation(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.start_setup_evaluation(jsonb,uuid[]),public.finish_setup_evaluation(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';

insert into supabase_migrations.schema_migrations(version,name,statements) values('0004','setup_analysis',array['-- Additive screenshot/AI layer. Existing locked plans and evaluator contracts remain immutable.
create table public.setup_proposals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null,
 strategy_version_id uuid not null, instrument_version_id uuid not null, risk_evaluation_id uuid not null,
 proposal jsonb not null check(jsonb_typeof(proposal)=''object''), request_key uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(user_id,account_id,id), unique(user_id,account_id,id,strategy_version_id), unique(user_id,request_key),
 foreign key(user_id,account_id) references public.accounts(user_id,id),
 foreign key(user_id,account_id,strategy_version_id) references public.strategy_versions(user_id,account_id,id),
 foreign key(user_id,account_id,instrument_version_id) references public.instrument_versions(user_id,account_id,id),
 foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id)
);
create table public.setup_locks (
 proposal_id uuid primary key, user_id uuid not null, account_id uuid not null, plan_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id),
 foreign key(user_id,account_id,plan_id) references public.trade_plans(user_id,account_id,id)
);
create table public.setup_risk_checks (
 id bigint generated always as identity primary key, user_id uuid not null, account_id uuid not null,
 proposal_id uuid not null, risk_evaluation_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id),
 foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id)
);
create table public.setup_screenshots (
 id uuid primary key, user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 role text not null check(role in (''DAILY'',''H4'',''H1'',''M30'',''M15'',''M5'',''M3'',''OTHER'')),
 storage_path text not null unique, original_filename text not null check(length(original_filename) between 1 and 255),
 mime_type text not null check(mime_type in (''image/png'',''image/jpeg'',''image/webp'')),
 byte_size integer not null check(byte_size between 1 and 10485760), sha256 text not null check(sha256 ~ ''^[0-9a-f]{64}$''),
 width integer not null check(width>0), height integer not null check(height>0),
 uploaded_at timestamptz not null default clock_timestamp(), unique(user_id,account_id,proposal_id,id),
 check(width::bigint*height<=40000000),
 check(storage_path=user_id::text||''/''||proposal_id::text||''/''||id::text),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id)
);
create table public.setup_screenshot_removals (
 screenshot_id uuid primary key references public.setup_screenshots(id), user_id uuid not null, account_id uuid not null,
 proposal_id uuid not null, recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id,screenshot_id) references public.setup_screenshots(user_id,account_id,proposal_id,id)
);
create table public.evaluator_versions (
 version text primary key, schema_version text not null, system_prompt text not null, json_schema jsonb not null,
 config jsonb not null, sha256 text not null check(sha256 ~ ''^[0-9a-f]{64}$''), created_at timestamptz not null default clock_timestamp()
);
create table public.setup_evaluations (
 id uuid primary key, user_id uuid not null, account_id uuid not null, proposal_id uuid not null, strategy_version_id uuid not null,
 evaluator_version text not null references public.evaluator_versions(version), mode text not null check(mode in (''NORMAL'',''DEEP'')),
 model text not null, manifest jsonb not null, input_hash text not null check(input_hash ~ ''^[0-9a-f]{64}$''),
 created_at timestamptz not null default clock_timestamp(), deadline_at timestamptz not null,
 unique(user_id,account_id,id),
 check(deadline_at>created_at and deadline_at<created_at+interval ''30 minutes''),
 foreign key(user_id,account_id,proposal_id,strategy_version_id) references public.setup_proposals(user_id,account_id,id,strategy_version_id)
);
create table public.setup_evaluation_screenshots (
 evaluation_id uuid not null, screenshot_id uuid not null, user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 primary key(evaluation_id,screenshot_id),
 foreign key(user_id,account_id,evaluation_id) references public.setup_evaluations(user_id,account_id,id),
 foreign key(user_id,account_id,proposal_id,screenshot_id) references public.setup_screenshots(user_id,account_id,proposal_id,id)
);
create table public.setup_evaluation_events (
 id bigint generated always as identity primary key, user_id uuid not null, account_id uuid not null, evaluation_id uuid not null,
 status text not null check(status in (''QUEUED'',''RUNNING'',''COMPLETED'',''FAILED'')), payload jsonb not null default ''{}'',
 created_at timestamptz not null default clock_timestamp(), unique(evaluation_id,status),
 foreign key(user_id,account_id,evaluation_id) references public.setup_evaluations(user_id,account_id,id)
);
create table public.setup_evaluation_passes (
 id uuid primary key, user_id uuid not null, account_id uuid not null, evaluation_id uuid not null,
 stage text not null check(stage in (''A'',''B'',''RECONCILER'')), status text not null check(status in (''VALID'',''INVALID'',''REFUSED'',''INCOMPLETE'',''FAILED'')),
 model text not null, response_id text, output jsonb, usage jsonb, error_code text,
 created_at timestamptz not null default clock_timestamp(), unique(evaluation_id,stage),
 check(status<>''VALID'' or output is not null),
 foreign key(user_id,account_id,evaluation_id) references public.setup_evaluations(user_id,account_id,id)
);
create table public.setup_human_decisions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 decision text not null check(decision in (''TAKEN'',''SKIPPED'')), event_type text not null check(event_type in (''HUMAN_DECISION'',''MANUAL_OVERRIDE'')),
 reason text check(length(reason)<=5000), risk_evaluation_id uuid not null, ai_evaluation_id uuid,
 ai_decision text not null, ai_context_status text not null, risk_decision text not null check(risk_decision in (''APPROVED'',''BLOCKED'')),
 recorded_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id),
 foreign key(user_id,account_id,risk_evaluation_id) references public.risk_evaluations(user_id,account_id,id),
 foreign key(user_id,account_id,ai_evaluation_id) references public.setup_evaluations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array[''setup_proposals'',''setup_locks'',''setup_risk_checks'',''setup_screenshots'',''setup_screenshot_removals'',''setup_evaluations'',''setup_evaluation_screenshots'',''setup_evaluation_events'',''setup_evaluation_passes'',''setup_human_decisions''] loop
 execute format(''alter table public.%I enable row level security'',t);
 execute format(''create policy owner_read on public.%I for select to authenticated using (user_id=auth.uid())'',t);
 execute format(''revoke all on public.%I from anon,authenticated'',t);
 execute format(''grant select on public.%I to authenticated'',t);
 execute format(''grant select,insert on public.%I to service_role'',t);
 execute format(''create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()'',t);
 end loop;
end $$;
alter table public.evaluator_versions enable row level security;
create policy authenticated_read on public.evaluator_versions for select to authenticated using (true);
revoke all on public.evaluator_versions from anon,authenticated;
grant select on public.evaluator_versions to authenticated;
grant select,insert on public.evaluator_versions to service_role;
create trigger immutable before update or delete on public.evaluator_versions for each row execute function private.reject_mutation();
grant usage,select on sequence public.setup_risk_checks_id_seq,public.setup_evaluation_events_id_seq to service_role;
create index on public.setup_proposals(account_id,created_at desc);
create index on public.setup_evaluations(proposal_id,created_at desc);
create index on public.setup_evaluation_events(evaluation_id,id desc);
create index on public.setup_screenshots(proposal_id);

create function public.save_setup_proposal(p_account_id uuid,p_proposal jsonb,p_key uuid,p_expected_risk_id uuid,p_expected_observation_id uuid)
returns uuid language plpgsql security definer set search_path='''' as $$
declare v public.setup_proposals; result jsonb; rid uuid; sid uuid; iid uuid;
begin
 perform 1 from public.accounts where id=p_account_id and user_id=auth.uid() for update;
 if not found or p_key is null then raise exception ''Account not found or missing request key''; end if;
 select * into v from public.setup_proposals where user_id=auth.uid() and request_key=p_key;
 if found then
   if v.account_id<>p_account_id or v.proposal is distinct from p_proposal then raise exception ''Idempotency conflict''; end if;
   return v.id;
 end if;
 result:=public.evaluate_trade_plan(p_account_id,p_proposal,p_expected_risk_id,p_expected_observation_id);
 rid:=(result->>''evaluationId'')::uuid;
 select strategy_version_id,instrument_version_id into sid,iid from public.risk_evaluations where id=rid;
 if result->''result''->''issues'' @> ''[{"code":"INVALID_INPUT"}]''::jsonb then raise exception ''Invalid proposal''; end if;
 insert into public.setup_proposals(user_id,account_id,strategy_version_id,instrument_version_id,risk_evaluation_id,proposal,request_key)
 values(auth.uid(),p_account_id,sid,iid,rid,p_proposal,p_key) returning * into v;
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,rid);
 return v.id;
end $$;
create function public.import_locked_setup(p_plan_id uuid) returns uuid language plpgsql security definer set search_path='''' as $$
declare p public.trade_plans; v uuid;
begin
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid();
 if not found then raise exception ''Plan not found''; end if;
 perform 1 from public.accounts where id=p.account_id for update;
 select proposal_id into v from public.setup_locks where plan_id=p.id;
 if found then return v; end if;
 insert into public.setup_proposals(user_id,account_id,strategy_version_id,instrument_version_id,risk_evaluation_id,proposal,request_key)
 values(p.user_id,p.account_id,p.strategy_version_id,p.instrument_version_id,p.risk_evaluation_id,p.proposal,p.id) returning id into v;
 insert into public.setup_locks(user_id,account_id,proposal_id,plan_id) values(p.user_id,p.account_id,v,p.id);
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(p.user_id,p.account_id,v,p.risk_evaluation_id);
 return v;
end $$;
create function public.check_setup_risk(p_proposal_id uuid,p_lock boolean default false) returns jsonb language plpgsql security definer set search_path='''' as $$
declare v public.setup_proposals; r uuid; o uuid; result jsonb; linked uuid;
 a public.accounts; obs public.account_observations; rp public.risk_plan_versions; inst public.instrument_versions;
 now_at timestamptz; slots integer; consumed numeric; duplicate boolean; report jsonb; rid uuid;
begin
 select * into v from public.setup_proposals where id=p_proposal_id and user_id=auth.uid();
 if not found then raise exception ''Proposal not found''; end if;
 perform 1 from public.accounts where id=v.account_id for update;
 select plan_id into linked from public.setup_locks where proposal_id=v.id;
 if linked is not null then
   if not p_lock then
     now_at:=clock_timestamp();
     select * into a from public.accounts where id=v.account_id;
     select * into obs from public.account_observations where account_id=v.account_id order by recorded_at desc,id desc limit 1;
     select * into rp from public.risk_plan_versions where account_id=v.account_id and effective_day<=private.strategy_day(now_at) order by effective_day desc,created_at desc,id desc limit 1;
     select * into inst from public.instrument_versions where id=v.instrument_version_id;
     if not exists(select 1 from public.strategy_versions where id=v.strategy_version_id and version=''ICT V1.0'') then raise exception ''Attached strategy is not supported by this risk engine''; end if;
     -- Recheck a reserved plan without double-counting its own reservation.
     select count(*),coalesce(sum(nominal_risk),0) into slots,consumed from public.trade_plans where account_id=v.account_id and trading_day=private.strategy_day(now_at) and id<>linked;
     select exists(select 1 from public.trade_plans p where p.account_id=v.account_id and p.trading_day=private.strategy_day(now_at) and p.id<>linked
       and p.instrument_version_id=v.instrument_version_id and p.proposal->>''direction''=v.proposal->>''direction'' and p.proposal->>''model''=v.proposal->>''model''
       and (p.proposal->>''entry'')::numeric=(v.proposal->>''entry'')::numeric and (p.proposal->>''stop'')::numeric=(v.proposal->>''stop'')::numeric and (p.proposal->>''target'')::numeric=(v.proposal->>''target'')::numeric) into duplicate;
     report:=private.risk_report(v.proposal,a,obs,rp,inst,v.strategy_version_id,now_at,slots,consumed,duplicate);
     insert into public.risk_evaluations(user_id,account_id,proposal,result,account_observation_id,strategy_version_id,risk_plan_version_id,instrument_version_id,source)
       values(v.user_id,v.account_id,v.proposal,report,obs.id,v.strategy_version_id,rp.id,inst.id,''EXPLICIT_CHECK'') returning id into rid;
     insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,rid);
     return jsonb_build_object(''planId'',linked,''evaluationId'',rid,''result'',report,''replayed'',false);
   end if;
   select jsonb_build_object(''planId'',id,''evaluationId'',risk_evaluation_id,''result'',risk_result,''replayed'',true) into result from public.trade_plans where id=linked;
   return result;
 end if;
 select id into r from public.risk_plan_versions where account_id=v.account_id and effective_day<=private.strategy_day(clock_timestamp()) order by effective_day desc,created_at desc,id desc limit 1;
 select id into o from public.account_observations where account_id=v.account_id order by recorded_at desc,id desc limit 1;
 result:=private.assess_plan(v.account_id,v.proposal,v.id,r,o,p_lock);
 -- Current deterministic engine supports ICT V1.0 only. Never retarget a future attached strategy.
 if (result#>>''{result,strategyVersionId}'')::uuid<>v.strategy_version_id then raise exception ''Attached strategy is not supported by this risk engine''; end if;
 insert into public.setup_risk_checks(user_id,account_id,proposal_id,risk_evaluation_id) values(v.user_id,v.account_id,v.id,(result->>''evaluationId'')::uuid);
 if result->>''planId'' is not null then
   insert into public.setup_locks(user_id,account_id,proposal_id,plan_id) values(v.user_id,v.account_id,v.id,(result->>''planId'')::uuid);
 end if;
 return result;
end $$;
create function public.remove_setup_screenshot(p_screenshot_id uuid) returns void language plpgsql security definer set search_path='''' as $$
declare s public.setup_screenshots;
begin
 select * into s from public.setup_screenshots where id=p_screenshot_id and user_id=auth.uid();
 if not found then raise exception ''Screenshot not found''; end if;
 perform 1 from public.setup_proposals where id=s.proposal_id for update;
 insert into public.setup_screenshot_removals(screenshot_id,user_id,account_id,proposal_id) values(s.id,s.user_id,s.account_id,s.proposal_id) on conflict do nothing;
end $$;

-- Only the trusted server can persist provider results. No authenticated RPC can forge an AI verdict.
create function public.start_setup_evaluation(p_record jsonb,p_screenshots uuid[]) returns uuid language plpgsql security definer set search_path='''' as $$
declare v public.setup_proposals; eid uuid:=(p_record->>''id'')::uuid; n integer;
begin
 select * into v from public.setup_proposals where id=(p_record->>''proposal_id'')::uuid and user_id=(p_record->>''user_id'')::uuid for update;
 if not found then raise exception ''Proposal not found''; end if;
 if exists(select 1 from public.setup_evaluations where id=eid) then raise exception ''Request already exists''; end if;
 -- Expired jobs are append-only failures; no result can later turn them into a success.
 insert into public.setup_evaluation_events(user_id,account_id,evaluation_id,status,payload)
 select e.user_id,e.account_id,e.id,''FAILED'',''{"error":"WORKER_TIMEOUT"}''::jsonb from public.setup_evaluations e
 where e.proposal_id=v.id and e.deadline_at<clock_timestamp() and not exists(select 1 from public.setup_evaluation_events x where x.evaluation_id=e.id and x.status in (''COMPLETED'',''FAILED''));
 if exists(select 1 from public.setup_evaluations e where e.proposal_id=v.id and not exists(select 1 from public.setup_evaluation_events x where x.evaluation_id=e.id and x.status in (''COMPLETED'',''FAILED''))) then raise exception ''An evaluation is already running''; end if;
 select count(*) into n from public.setup_screenshots s where s.id=any(p_screenshots) and s.proposal_id=v.id and s.user_id=v.user_id and not exists(select 1 from public.setup_screenshot_removals x where x.screenshot_id=s.id);
 if n<1 or n>8 or n<>cardinality(p_screenshots) then raise exception ''Invalid screenshot selection''; end if;
 if (select sum(byte_size) from public.setup_screenshots where id=any(p_screenshots))>41943040 then raise exception ''Screenshot batch exceeds 40 MB''; end if;
 insert into public.setup_evaluations(id,user_id,account_id,proposal_id,strategy_version_id,evaluator_version,mode,model,manifest,input_hash,deadline_at)
 values(eid,v.user_id,v.account_id,v.id,v.strategy_version_id,p_record->>''evaluator_version'',p_record->>''mode'',p_record->>''model'',p_record->''manifest'',p_record->>''input_hash'',(p_record->>''deadline_at'')::timestamptz);
 insert into public.setup_evaluation_screenshots(evaluation_id,screenshot_id,user_id,account_id,proposal_id) select eid,id,v.user_id,v.account_id,v.id from public.setup_screenshots where id=any(p_screenshots);
 insert into public.setup_evaluation_events(user_id,account_id,evaluation_id,status) values(v.user_id,v.account_id,eid,''QUEUED''),(v.user_id,v.account_id,eid,''RUNNING'');
 return eid;
end $$;
create function public.finish_setup_evaluation(p_id uuid,p_status text,p_payload jsonb) returns void language plpgsql security definer set search_path='''' as $$
declare e public.setup_evaluations;
begin
 select * into e from public.setup_evaluations where id=p_id for update;
 if not found or p_status not in (''COMPLETED'',''FAILED'') then raise exception ''Invalid completion''; end if;
 if exists(select 1 from public.setup_evaluation_events where evaluation_id=e.id and status in (''COMPLETED'',''FAILED'')) then raise exception ''Evaluation is already terminal''; end if;
 if e.deadline_at<clock_timestamp() then p_status:=''FAILED''; p_payload:=''{"error":"WORKER_TIMEOUT"}''::jsonb; end if;
 if p_status=''COMPLETED'' and (p_payload#>>''{result,decision}'' is null or p_payload#>>''{result,decision}'' not in (''APPROVED'',''CONDITIONAL'',''BLOCKED'',''INSUFFICIENT_EVIDENCE'') or not exists(select 1 from public.setup_evaluation_passes where evaluation_id=e.id and status=''VALID'' and stage=case when e.mode=''DEEP'' then ''RECONCILER'' else ''A'' end)) then raise exception ''Missing validated result''; end if;
 insert into public.setup_evaluation_events(user_id,account_id,evaluation_id,status,payload) values(e.user_id,e.account_id,e.id,p_status,p_payload);
end $$;
create function public.record_setup_decision(p_proposal_id uuid,p_decision text,p_reason text default null) returns uuid language plpgsql security definer set search_path='''' as $$
declare v public.setup_proposals; risk jsonb; ai uuid; verdict text; event text; result_id uuid; context_status text;
begin
 select * into v from public.setup_proposals where id=p_proposal_id and user_id=auth.uid();
 if not found or p_decision is null or p_decision not in (''TAKEN'',''SKIPPED'') or length(p_reason)>5000 then raise exception ''Invalid decision or proposal''; end if;
 perform 1 from public.accounts where id=v.account_id for update;
 risk:=public.check_setup_risk(v.id,false);
 select e.id into ai from public.setup_evaluations e where e.proposal_id=v.id and exists(select 1 from public.setup_evaluation_events x where x.evaluation_id=e.id and x.status=''COMPLETED'') order by e.created_at desc,e.id desc limit 1;
 select payload#>>''{result,decision}'' into verdict from public.setup_evaluation_events where evaluation_id=ai and status=''COMPLETED'';
 verdict:=coalesce(verdict,''NOT_EVALUATED'');
 context_status:=case when ai is null then ''NOT_EVALUATED'' else ''CURRENT'' end;
 if ai is not null and exists(
   (select s.id from public.setup_screenshots s where s.proposal_id=v.id and not exists(select 1 from public.setup_screenshot_removals r where r.screenshot_id=s.id) except select screenshot_id from public.setup_evaluation_screenshots where evaluation_id=ai)
   union all
   (select screenshot_id from public.setup_evaluation_screenshots where evaluation_id=ai except select s.id from public.setup_screenshots s where s.proposal_id=v.id and not exists(select 1 from public.setup_screenshot_removals r where r.screenshot_id=s.id))
 ) then context_status:=''EVIDENCE_CHANGED''; end if;
 if ai is not null and ai<>(select id from public.setup_evaluations where proposal_id=v.id order by created_at desc,id desc limit 1) then context_status:=''NEWER_REVIEW_NOT_COMPLETED''; end if;
 event:=case when p_decision=''TAKEN'' and (verdict=''BLOCKED'' or risk#>>''{result,decision}''=''BLOCKED'') then ''MANUAL_OVERRIDE'' else ''HUMAN_DECISION'' end;
 insert into public.setup_human_decisions(user_id,account_id,proposal_id,decision,event_type,reason,risk_evaluation_id,ai_evaluation_id,ai_decision,ai_context_status,risk_decision)
 values(v.user_id,v.account_id,v.id,p_decision,event,p_reason,(risk->>''evaluationId'')::uuid,ai,verdict,context_status,risk#>>''{result,decision}'') returning id into result_id;
 return result_id;
end $$;
revoke all on function public.save_setup_proposal(uuid,jsonb,uuid,uuid,uuid),public.import_locked_setup(uuid),public.check_setup_risk(uuid,boolean),public.remove_setup_screenshot(uuid),public.record_setup_decision(uuid,text,text) from public,anon;
grant execute on function public.save_setup_proposal(uuid,jsonb,uuid,uuid,uuid),public.import_locked_setup(uuid),public.check_setup_risk(uuid,boolean),public.remove_setup_screenshot(uuid),public.record_setup_decision(uuid,text,text) to authenticated;
revoke all on function public.start_setup_evaluation(jsonb,uuid[]),public.finish_setup_evaluation(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.start_setup_evaluation(jsonb,uuid[]),public.finish_setup_evaluation(uuid,text,jsonb) to service_role;
notify pgrst,''reload schema'';
']);
do $guard$ begin if exists(select 1 from supabase_migrations.schema_migrations where version='0005') then raise exception 'Migration 0005 already applied; stop and inspect history'; end if; end $guard$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('setup-screenshots','setup-screenshots',false,4194304,array['image/png','image/jpeg','image/webp']);
-- Authenticated users may read only registered evidence belonging to them.
-- Uploads go through byte validation on the trusted application server. No browser writes/deletes.
create policy setup_screenshot_owner_read on storage.objects for select to authenticated
using(bucket_id='setup-screenshots' and exists(
 select 1 from public.setup_screenshots s where s.storage_path=name and s.user_id=auth.uid()
));
-- Restrictive policies also prevent an unrelated permissive policy from opening this bucket.
create policy setup_screenshot_read_guard on storage.objects as restrictive for select to anon,authenticated
using(bucket_id<>'setup-screenshots' or exists(select 1 from public.setup_screenshots s where s.storage_path=name and s.user_id=auth.uid()));
create policy setup_screenshot_insert_guard on storage.objects as restrictive for insert to anon,authenticated
with check(bucket_id<>'setup-screenshots');
create policy setup_screenshot_update_guard on storage.objects as restrictive for update to anon,authenticated
using(bucket_id<>'setup-screenshots') with check(bucket_id<>'setup-screenshots');
create policy setup_screenshot_delete_guard on storage.objects as restrictive for delete to anon,authenticated
using(bucket_id<>'setup-screenshots');

insert into supabase_migrations.schema_migrations(version,name,statements) values('0005','private_screenshot_storage',array['insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(''setup-screenshots'',''setup-screenshots'',false,4194304,array[''image/png'',''image/jpeg'',''image/webp'']);
-- Authenticated users may read only registered evidence belonging to them.
-- Uploads go through byte validation on the trusted application server. No browser writes/deletes.
create policy setup_screenshot_owner_read on storage.objects for select to authenticated
using(bucket_id=''setup-screenshots'' and exists(
 select 1 from public.setup_screenshots s where s.storage_path=name and s.user_id=auth.uid()
));
-- Restrictive policies also prevent an unrelated permissive policy from opening this bucket.
create policy setup_screenshot_read_guard on storage.objects as restrictive for select to anon,authenticated
using(bucket_id<>''setup-screenshots'' or exists(select 1 from public.setup_screenshots s where s.storage_path=name and s.user_id=auth.uid()));
create policy setup_screenshot_insert_guard on storage.objects as restrictive for insert to anon,authenticated
with check(bucket_id<>''setup-screenshots'');
create policy setup_screenshot_update_guard on storage.objects as restrictive for update to anon,authenticated
using(bucket_id<>''setup-screenshots'') with check(bucket_id<>''setup-screenshots'');
create policy setup_screenshot_delete_guard on storage.objects as restrictive for delete to anon,authenticated
using(bucket_id<>''setup-screenshots'');
']);
commit;
select version,name from supabase_migrations.schema_migrations order by version;
select id,public,file_size_limit from storage.buckets where id='setup-screenshots';
