// Real network acceptance tests. Never uses an admin/service key for assertions.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {evaluationEnvelopeSchema,riskReportSchema} from '../src/domain/risk-report.ts';
loadEnvFile('.env.local');
const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));assert.equal(project,url);assert.equal(users.length,2);
const client=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const a=client(),b=client(),anon=client(),checks=[];
async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`);}
async function data(request){const r=await request;if(r.error)throw Error(`${r.error.code ?? r.error.status}: ${r.error.message}`);return r.data;}
async function login(db,user){return data(db.auth.signInWithPassword({email:user.email,password:user.password}));}
async function bootstrap(db,user,name,requestKey=user.id){return data(db.rpc('bootstrap_demo_account',{p_idempotency_key:requestKey,p_name:name,p_equity:'10000',p_balance:'10000'}));}
async function context(db,id){
  const [r,o,i,s]=await Promise.all([
    data(db.from('risk_plan_versions').select('id,version').eq('account_id',id).order('created_at',{ascending:false}).limit(1).single()),
    data(db.from('account_observations').select('id').eq('account_id',id).order('recorded_at',{ascending:false}).limit(1).single()),
    data(db.from('instrument_versions').select('id').eq('account_id',id).eq('symbol','EURUSD').single()),
    data(db.from('strategy_versions').select('id,version').eq('account_id',id).single())]);
  return {id,r,o,i,s};
}
const proposal=(c,changes={})=>({instrumentId:c.i.id,direction:'LONG',model:'OB_FIRST_TOUCH',entry:'1.1',stop:'1.098',target:'1.106',riskPercent:'0.5',narrative:'Live deterministic persistence acceptance test; synthetic demo plan.',contractConfirmed:true,news:'UNKNOWN',contradiction:false,...changes});
async function assess(db,c,p,requestKey){return evaluationEnvelopeSchema.parse(await data(db.rpc(requestKey?'lock_trade_plan':'evaluate_trade_plan',{p_account_id:c.id,p_proposal:p,p_expected_risk_id:c.r.id,p_expected_observation_id:c.o.id,...(requestKey?{p_idempotency_key:requestKey}:{})})));}
let c,locked,raceAccount;
await check('Two real password sign-ins',async()=>{await login(a,users[0]);await login(b,users[1]);});
await check('Atomic bootstrap replay with immutable initial versions',async()=>{
  const id=await bootstrap(b,users[1],'API persistence verification');assert.equal(await bootstrap(b,users[1],'API persistence verification'),id);c=await context(b,id);assert.equal(c.s.version,'ICT V1.0');assert.equal(c.r.version,'Risk Plan V1.0');
  for(const table of ['strategy_versions','risk_plan_versions','account_observations']) assert.equal((await data(b.from(table).select('id').eq('account_id',id))).length,1);
  assert.ok((await b.rpc('bootstrap_demo_account',{p_idempotency_key:users[1].id,p_name:'Conflicting retry',p_equity:'10000',p_balance:'10000'})).error);
});
await check('Approved and blocked evaluations persist without a reservation',async()=>{
  const good=await assess(b,c,proposal(c));const report=riskReportSchema.parse(good.result);assert.equal(report.decision,'APPROVED','Real server clock must permit this lock workflow; do not simulate the session.');assert.equal(good.planId,null);assert.equal(report.calculations.budget,'50.00');assert.equal(Number(report.calculations.plannedRR),3);
  assert.equal(report.ruleResults.find(r=>r.rule==='NEWS_RESTRICTED').outcome,'NOT_EVALUATED');
  for(const bad of [{stop:null},{riskPercent:'0.51'},{entry:'NaN'},{direction:null},{target:'1.10599'}]){const e=await assess(b,c,proposal(c,bad));assert.equal(e.result.decision,'BLOCKED');assert.equal(e.planId,null);assert.ok(e.result.issues.some(i=>i.severity==='BLOCK'));}
  assert.equal((await data(b.from('trade_plans').select('id').eq('account_id',c.id))).length,0);
  assert.equal((await data(b.from('risk_evaluations').select('id').eq('account_id',c.id).eq('source','EXPLICIT_CHECK'))).length,6);
});
await check('Lock persists exact original versions and idempotent audit history',async()=>{
  const requestKey=randomUUID();locked=await assess(b,c,proposal(c),requestKey);assert.ok(locked.planId);const replay=await assess(b,c,proposal(c),requestKey);assert.equal(replay.planId,locked.planId);assert.equal(replay.replayed,true);
  const row=await data(b.from('trade_plans').select('*').eq('id',locked.planId).single());assert.equal(row.strategy_version_id,c.s.id);assert.equal(row.risk_plan_version_id,c.r.id);assert.equal(row.account_observation_id,c.o.id);assert.deepEqual(row.proposal,proposal(c));
  assert.equal((await data(b.from('trade_events').select('id').eq('plan_id',locked.planId))).length,1);
  assert.equal((await data(b.from('risk_evaluations').select('id').eq('account_id',c.id).eq('source','LOCK_RECHECK'))).length,1);
});
await check('Locked values cannot be changed; notes append in order',async()=>{
  assert.ok((await b.from('trade_plans').update({proposal:{entry:'99'}}).eq('id',locked.planId)).error);
  assert.ok((await b.from('trade_plans').delete().eq('id',locked.planId)).error);
  for(const table of ['strategy_versions','risk_plan_versions']) assert.ok((await b.from(table).update({version:'Edited'}).eq('account_id',c.id)).error);
  await data(b.rpc('append_plan_note',{p_plan_id:locked.planId,p_note:'A later observation; original values retained.'}));
  const events=await data(b.from('trade_events').select('event_type,sequence').eq('plan_id',locked.planId).order('sequence'));assert.deepEqual(events.map(e=>e.event_type),['PLAN_LOCKED','NOTE_ADDED']);
  assert.deepEqual((await data(b.from('trade_plans').select('proposal').eq('id',locked.planId).single())).proposal,proposal(c));
});
const tables=['accounts','account_observations','strategy_versions','risk_plan_versions','instrument_versions','risk_evaluations','trade_plans','trade_events','configuration_events','daily_contexts','chart_assets','plan_chart_assets','ai_analysis_attempts','trade_reviews','strategy_experiments','experiment_reviews','bootstrap_requests'];
await check('Two-user RLS and anonymous denial across all 17 tenant tables',async()=>{
  const ownA=await data(a.from('accounts').select('id'));assert.ok(ownA.length>0,'Browser user must complete account bootstrap first');
  assert.ok((await data(a.from('trade_plans').select('id'))).length>0,'Browser user must lock a plan first');
  for(const table of tables){
    assert.deepEqual(await data(a.from(table).select('*').eq('user_id',users[1].id)),[]);
    assert.deepEqual(await data(b.from(table).select('*').eq('user_id',users[0].id)),[]);
    assert.ok((await anon.from(table).select('*').limit(1)).error,`${table} anonymous read`);
    assert.ok((await a.from(table).delete().eq('user_id',users[1].id)).error,`${table} direct delete`);
  }
  assert.ok((await a.rpc('evaluate_trade_plan',{p_account_id:c.id,p_proposal:proposal(c),p_expected_risk_id:c.r.id,p_expected_observation_id:c.o.id})).error);
  assert.ok((await a.rpc('append_plan_note',{p_plan_id:locked.planId,p_note:'Forbidden'})).error);
  assert.ok((await anon.rpc('bootstrap_demo_account',{p_idempotency_key:randomUUID(),p_name:'Denied',p_equity:'10000',p_balance:'10000'})).error);
});
await check('Independent simultaneous requests cannot both reserve the final slot',async()=>{
  raceAccount=await bootstrap(b,users[1],'Concurrent slot verification',randomUUID());const rc=await context(b,raceAccount);assert.ok((await assess(b,rc,proposal(rc),randomUUID())).planId);
  const b2=client();await login(b2,users[1]);
  const results=await Promise.all([assess(b,rc,proposal(rc,{entry:'1.2',stop:'1.198',target:'1.206'}),randomUUID()),assess(b2,rc,proposal(rc,{entry:'1.3',stop:'1.298',target:'1.306'}),randomUUID())]);
  assert.equal(results.filter(r=>r.planId).length,1);assert.ok(results.find(r=>!r.planId).result.issues.some(i=>i.code==='MAX_TRADES'));
  assert.equal((await data(b.from('trade_plans').select('id').eq('account_id',raceAccount))).length,2);await b2.auth.signOut({scope:'local'});
});
await check('Sign out, fresh sign-in and journal relationships preserve the plan',async()=>{
  await data(b.auth.signOut({scope:'local'}));assert.ok((await b.from('trade_plans').select('id')).error);
  const fresh=client();await login(fresh,users[1]);const row=await data(fresh.from('trade_plans').select('id,risk_result,nominal_risk::text,instrument:instrument_versions(symbol),strategy:strategy_versions(version),risk:risk_plan_versions(version)').eq('id',locked.planId).single());
  assert.equal(row.id,locked.planId);assert.equal(row.strategy.version,'ICT V1.0');assert.equal(row.risk.version,'Risk Plan V1.0');assert.equal(row.instrument.symbol,'EURUSD');riskReportSchema.parse(row.risk_result);await fresh.auth.signOut({scope:'local'});
});
await check('Private server routes reject signed-out and invalid-cookie requests',async()=>{
  for(const cookie of ['',`sb-${new URL(url).hostname.split('.')[0]}-auth-token=invalid-session`]){const response=await fetch('http://127.0.0.1:3000/journal',{headers:cookie?{cookie}:{},redirect:'manual'});assert.equal(response.status,307);assert.ok(response.headers.get('location').includes('/login'));assert.match(response.headers.get('cache-control'),/no-store/);}
});
const report={verifiedAt:new Date().toISOString(),project:url,checks:checks.length,passed:checks,planId:locked.planId,accountId:c.id,raceAccountId:raceAccount,rlsTables:tables,limitations:['Reserved screenshot/AI tables have no feature data yet; owner policy and deny-write tests passed.','Uses actual Supabase clock; no broker executions or position closures.']};
writeFileSync('docs/LIVE_VERIFICATION.json',JSON.stringify(report,null,2));await a.auth.signOut({scope:'local'});console.log(`LIVE ACCEPTANCE PASSED: ${checks.length} checks`);
