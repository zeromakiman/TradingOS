// Generates a reviewed, one-time SQL fixture transaction. Does not execute SQL or call AI.
import {readFileSync,writeFileSync} from 'node:fs';
const {users}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));
if(!/^[0-9a-f-]{36}$/.test(users[1].id))throw Error('Invalid test user');
const sql=`begin;
do $fixtures$
declare a public.accounts; s public.strategy_versions; r public.risk_plan_versions; i public.instrument_versions; o public.account_observations; v jsonb; result jsonb; evaluation uuid; plan uuid; entry_time timestamptz; lock_time timestamptz; model text; price text; n int; account_id uuid;
begin
 perform set_config('request.jwt.claim.sub','${users[1].id}',true);
 if exists(select 1 from public.accounts where user_id=auth.uid() and name='EDGE V1 historical fixtures · SYNTHETIC') then raise exception 'Historical fixture account already exists; do not duplicate'; end if;
 account_id:=public.bootstrap_demo_account(gen_random_uuid(),'EDGE V1 historical fixtures · SYNTHETIC','10000','10000');
 select * into a from public.accounts where id=account_id and user_id=auth.uid();
 if a.id is null then raise exception 'Test owner mismatch'; end if;
 select * into i from public.instrument_versions where instrument_versions.account_id=a.id and symbol='EURUSD';
 select * into s from public.strategy_versions where strategy_versions.account_id=a.id limit 1;
 -- Explicit synthetic versions, not revisions to any real historical strategy or risk policy.
 insert into public.strategy_versions(user_id,account_id,version,rules,written_rules,created_at)
 values(a.user_id,a.id,'ICT V1.1 · SYNTHETIC TEST',s.rules,'Synthetic comparison fixture: copied V1 rules, no trading recommendation.','2026-08-30T00:00:00Z');
 insert into public.risk_plan_versions(user_id,account_id,version,effective_day,max_risk_percent,max_daily_trades,min_rr,rr_policy,news_policy,created_at)
 values(a.user_id,a.id,'Risk fixture V1','2026-08-30',0.5,10,3,'BLOCK','BLOCK','2026-08-30T00:00:00Z') returning * into r;
 for n in 1..4 loop
  entry_time:=(array['2026-09-01T06:30:00Z','2026-09-02T23:30:00Z','2026-09-03T08:30:00Z','2026-09-04T17:30:00Z'])[n]::timestamptz;
  lock_time:=case when n=4 then '2026-09-04T16:30:00Z'::timestamptz else entry_time-interval '1 minute' end;
  model:=case when n%2=0 then 'OTE' else 'OB_FIRST_TOUCH' end;
  select * into s from public.strategy_versions where strategy_versions.account_id=a.id and version=case when n<=2 then 'ICT V1.0' else 'ICT V1.1 · SYNTHETIC TEST' end;
  insert into public.account_observations(user_id,account_id,equity,balance,gross_loss_today,trading_day,recorded_at)
  values(a.user_id,a.id,10000,10000,0,private.strategy_day(lock_time),lock_time) returning * into o;
  v:=jsonb_build_object('instrumentId',i.id,'direction','LONG','model',model,'entry','1.1','stop','1.098','target','1.106','riskPercent','0.5','narrative','SYNTHETIC historical acceptance fixture. Not a real trade or historical market claim.','contractConfirmed',true,'news','CLEAR','contradiction',false);
  result:=private.risk_report(v,a,o,r,i,s.id,lock_time,0,0,false);
  if result->>'decision'<>'APPROVED' then raise exception 'Synthetic fixture risk was not approved: %',result; end if;
  insert into public.risk_evaluations(user_id,account_id,proposal,result,account_observation_id,strategy_version_id,risk_plan_version_id,instrument_version_id,source,recorded_at)
  values(a.user_id,a.id,v,result,o.id,s.id,r.id,i.id,'LOCK_RECHECK',lock_time) returning id into evaluation;
  insert into public.trade_plans(user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at)
  values(a.user_id,a.id,s.id,r.id,i.id,o.id,evaluation,gen_random_uuid(),v,result,50,private.strategy_day(lock_time),lock_time) returning id into plan;
  insert into public.trade_events(user_id,account_id,plan_id,event_type,payload,occurred_at)
  values(a.user_id,a.id,plan,'PLAN_LOCKED',jsonb_build_object('source','SYNTHETIC_ACCEPTANCE_FIXTURE','risk_evaluation_id',evaluation),lock_time);
  perform public.open_journal_trade(plan,'1.1','0.25',entry_time);
  price:=(array['1.104','1.098','1.1','1.106'])[n];
  perform public.close_journal_trade(plan,price,entry_time+interval '10 minutes','0');
 end loop;
end $fixtures$;
commit;
select a.name,t.status,t.instrument,t.entry_model,t.entered_at,t.realized_r,t.strategy_version from public.journal_analytics t join public.accounts a on a.id=t.account_id where a.user_id='${users[1].id}' and a.name='EDGE V1 historical fixtures · SYNTHETIC' order by t.entered_at;
`;
writeFileSync('.local/edge-fixtures.sql',sql);
console.log('Prepared four historical fixtures for the existing isolated test user. No SQL executed.');
