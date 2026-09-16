-- Additive pre-deployment hardening. Existing immutable history is preserved.
-- Serialize screenshot registration/removal on the same proposal row.
create function private.guard_screenshot_registration() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.setup_proposals where id=new.proposal_id for update;
 if (select count(*) from public.setup_screenshots s where s.proposal_id=new.proposal_id
     and not exists(select 1 from public.setup_screenshot_removals r where r.screenshot_id=s.id))>=8 then
  raise exception 'Screenshot limit reached' using errcode='P0001';
 end if;
 if new.byte_size>4194304 then raise exception 'Screenshot exceeds size limit'; end if;
 return new;
end $$;
revoke all on function private.guard_screenshot_registration() from public,anon,authenticated;
create trigger screenshot_registration_guard before insert on public.setup_screenshots
for each row execute function private.guard_screenshot_registration();
create index setup_risk_checks_proposal on public.setup_risk_checks(proposal_id,id desc);

-- Evidence must reference its own proposal, and an outcome its own execution/plan.
alter table public.setup_evaluations add constraint evaluation_proposal_identity unique(user_id,account_id,proposal_id,id);
alter table public.setup_evaluation_screenshots add constraint evidence_same_proposal
 foreign key(user_id,account_id,proposal_id,evaluation_id) references public.setup_evaluations(user_id,account_id,proposal_id,id);
alter table public.setup_human_decisions add constraint decision_same_proposal
 foreign key(user_id,account_id,proposal_id,ai_evaluation_id) references public.setup_evaluations(user_id,account_id,proposal_id,id);
alter table public.trade_executions add constraint execution_plan_identity unique(user_id,account_id,plan_id,id);
alter table public.trade_outcomes add constraint outcome_same_plan
 foreign key(user_id,account_id,plan_id,execution_id) references public.trade_executions(user_id,account_id,plan_id,id);
alter table public.trade_executions add constraint finite_execution check(
 entry_price not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and quantity not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and initial_risk not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and isfinite(entered_at) and isfinite(recorded_at));
alter table public.trade_outcomes add constraint finite_outcome check(
 exit_price not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and fees not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and gross_pnl not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and net_pnl not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and realized_r not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
 and isfinite(exited_at) and isfinite(recorded_at));

-- Each browser submission retains a key across retries. Old events have null keys.
alter table public.trade_events add column request_key uuid;
create unique index trade_event_request_key on public.trade_events(user_id,request_key) where request_key is not null;
create function public.append_plan_note(p_plan_id uuid,p_note text,p_request_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.trade_plans; e public.trade_events; result uuid; note text:=trim(p_note);
begin
 if p_request_key is null or note is null or length(note) not between 1 and 5000 then raise exception 'A request key and note are required'; end if;
 select * into p from public.trade_plans where id=p_plan_id and user_id=auth.uid() for update;
 if not found then raise exception 'Plan not found'; end if;
 select * into e from public.trade_events where user_id=p.user_id and request_key=p_request_key;
 if found then
  if e.plan_id<>p.id or e.event_type<>'NOTE_ADDED' or e.payload->>'note'<>note then raise exception 'Note request key already used'; end if;
  return e.id;
 end if;
 insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at,request_key)
 values(p.user_id,p.account_id,p.id,'NOTE_ADDED',jsonb_build_object('note',note),clock_timestamp(),p_request_key) returning id into result;
 return result;
end $$;
-- Obsolete unkeyed calls fail safely; source and historical records remain intact.
revoke all on function public.append_plan_note(uuid,text) from public,anon,authenticated;
revoke all on function public.append_plan_note(uuid,text,uuid) from public,anon;
grant execute on function public.append_plan_note(uuid,text,uuid) to authenticated;
notify pgrst,'reload schema';
