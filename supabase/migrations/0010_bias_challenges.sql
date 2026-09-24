-- Pre-lock advisory history shared by CHALLENGE_BIAS and ANALYZE_SETUP. Legacy table/RPC names retained.
-- Extended locally before staging; no new tables, grants or hosted migration.
-- Pre-lock advisory history. 0009 is deliberately unchanged: it requires a closed trade.
-- Existing setup evaluation tables require AI trading decisions; this feature must not produce one.
create table public.bias_challenges (
 id uuid primary key, user_id uuid not null, account_id uuid not null, proposal_id uuid not null,
 facts jsonb not null check(jsonb_typeof(facts)='object'), input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 operation jsonb not null check(coalesce(operation->>'id' in ('CHALLENGE_BIAS','ANALYZE_SETUP'),false)),
 contract jsonb not null check(jsonb_typeof(contract)='object'),
 created_at timestamptz not null default clock_timestamp(), deadline_at timestamptz not null default clock_timestamp()+interval '10 minutes',
 unique(user_id,account_id,id),
 foreign key(user_id,account_id,proposal_id) references public.setup_proposals(user_id,account_id,id)
);
create index on public.bias_challenges(proposal_id,created_at desc);
create table public.bias_challenge_results (
 challenge_id uuid primary key, user_id uuid not null, account_id uuid not null,
 status text not null check(status in ('COMPLETED','FAILED')), interpretation jsonb, error_code text, raw_output jsonb,
 reservation_id uuid, created_at timestamptz not null default clock_timestamp(),
 check((status='COMPLETED' and interpretation is not null and jsonb_typeof(interpretation)='object' and error_code is null) or (status='FAILED' and interpretation is null and error_code is not null)),
 foreign key(user_id,account_id,challenge_id) references public.bias_challenges(user_id,account_id,id),
 foreign key(user_id,account_id,reservation_id) references public.ai_request_reservations(user_id,account_id,id)
);
do $$ declare t text; begin
 foreach t in array array['bias_challenges','bias_challenge_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy owner_read on public.%I for select to authenticated using(user_id=auth.uid())',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated,service_role',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
 end loop;
end $$;
create function public.start_bias_challenge(p_id uuid,p_user_id uuid,p_proposal_id uuid,p_facts jsonb,p_hash text,p_operation jsonb,p_contract jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.setup_proposals; existing public.bias_challenges;
begin
 if coalesce(p_operation->>'id','') not in ('CHALLENGE_BIAS','ANALYZE_SETUP') then raise exception 'Unknown proposal AI operation'; end if;
 select * into p from public.setup_proposals where id=p_proposal_id and user_id=p_user_id;
 if not found then raise exception 'Proposal not found'; end if;
 -- Same account lock used by deterministic plan locking, without changing its behavior.
 perform 1 from public.accounts where id=p.account_id and user_id=p_user_id for update;
 select * into existing from public.bias_challenges where id=p_id;
 if found then
  if existing.user_id<>p_user_id or existing.proposal_id<>p.id or existing.operation->>'id' is distinct from p_operation->>'id' then raise exception 'Challenge not found'; end if;
  return false;
 end if;
 if exists(select 1 from public.setup_locks where proposal_id=p.id) then raise exception 'Plan already locked'; end if;
 if exists(select 1 from public.bias_challenges c where c.proposal_id=p.id and c.deadline_at>clock_timestamp() and not exists(select 1 from public.bias_challenge_results r where r.challenge_id=c.id)) then raise exception 'Challenge already running'; end if;
 insert into public.bias_challenges(id,user_id,account_id,proposal_id,facts,input_hash,operation,contract) values(p_id,p.user_id,p.account_id,p.id,p_facts,p_hash,p_operation,p_contract);
 return true;
end $$;
create function public.authorize_bias_challenge(p_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c public.bias_challenges; image jsonb;
begin
 select * into c from public.bias_challenges where id=p_id and user_id=p_user_id;
 if not found then raise exception 'Challenge not found'; end if;
 perform 1 from public.accounts where id=c.account_id and user_id=p_user_id for update;
 if c.deadline_at<=clock_timestamp() or exists(select 1 from public.bias_challenge_results where challenge_id=c.id) then raise exception 'Challenge already ended'; end if;
 if exists(select 1 from public.setup_locks where proposal_id=c.proposal_id) then raise exception 'Plan already locked'; end if;
 for image in select * from jsonb_array_elements(coalesce(c.facts->'selectedEvidence','[]'::jsonb)) loop
  if not exists(select 1 from public.setup_screenshots s where s.id=(image->>'id')::uuid and s.user_id=c.user_id and s.proposal_id=c.proposal_id and s.sha256=image->>'sha256' and not exists(select 1 from public.setup_screenshot_removals r where r.screenshot_id=s.id)) then raise exception 'Selected evidence changed'; end if;
 end loop;
end $$;
create function public.finish_bias_challenge(p_id uuid,p_user_id uuid,p_status text,p_interpretation jsonb,p_error text,p_raw jsonb,p_reservation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c public.bias_challenges;
begin
 select * into c from public.bias_challenges where id=p_id and user_id=p_user_id for update;
 if not found then raise exception 'Challenge not found'; end if;
 if p_reservation_id is not null and not exists(select 1 from public.ai_request_reservations where id=p_reservation_id and user_id=c.user_id and account_id=c.account_id and operation_id=c.id and operation=c.operation->>'id') then raise exception 'Reservation mismatch'; end if;
 if p_status='COMPLETED' and not exists(select 1 from public.ai_usage_records where reservation_id=p_reservation_id and user_id=c.user_id and disposition='SETTLED') then raise exception 'Usage must be reconciled before completion'; end if;
 -- A plan locked while generation was in flight is never altered; preserve the earlier snapshot/result.
 insert into public.bias_challenge_results(challenge_id,user_id,account_id,status,interpretation,error_code,raw_output,reservation_id) values(c.id,c.user_id,c.account_id,p_status,p_interpretation,p_error,p_raw,p_reservation_id);
end $$;
revoke all on function public.start_bias_challenge(uuid,uuid,uuid,jsonb,text,jsonb,jsonb),public.authorize_bias_challenge(uuid,uuid),public.finish_bias_challenge(uuid,uuid,text,jsonb,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.start_bias_challenge(uuid,uuid,uuid,jsonb,text,jsonb,jsonb),public.authorize_bias_challenge(uuid,uuid),public.finish_bias_challenge(uuid,uuid,text,jsonb,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
