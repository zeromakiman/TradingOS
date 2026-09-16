// Local application + Supabase only. No AI network usage is permitted.
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServerClient} from '@supabase/ssr';
loadEnvFile('.env.local');assert.notEqual(process.env.AI_ENABLED,'true');
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));
assert.equal(project,process.env.NEXT_PUBLIC_SUPABASE_URL);
const base='http://127.0.0.1:3000',jar=new Map(),checks=[];
const db=createServerClient(project,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:values=>values.forEach(c=>{jar.set(c.name,c.value);})}});
async function data(query){const r=await query;if(r.error)throw Error(r.error.message);return r.data;}
const headers=()=>({Origin:base,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')});
async function html(path){const r=await fetch(`${base}${path}`,{headers:headers()});assert.equal(r.status,200,path);return (await r.text()).replace(/<!--[\s\S]*?-->/g,'');}
const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#x27;',"'").replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>');
async function submitJournal(planId,action,fields){
 const page=await html(`/journal/${planId}`);
 const form=[...page.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(m=>m[0]).find(s=>s.includes(`name="action" value="${action}"`));assert.ok(form,`Missing ${action} journal form`);
 const body=new FormData();for(const input of form.matchAll(/<input\b[^>]*>/g)){const name=/name="([^"]*)"/.exec(input[0])?.[1],value=/value="([^"]*)"/.exec(input[0])?.[1];if(name)body.set(decode(name),decode(value??''));}
 for(const [k,v] of Object.entries(fields))body.set(k,v);
 const r=await fetch(`${base}/journal/${planId}`,{method:'POST',headers:headers(),body});assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes('role="alert"'),`Journal ${action}: ${text.match(/role="alert"[^>]*>([^<]*)/)?.[1]??"unknown error"}`);
}
const report={verified_at:new Date().toISOString(),completed:false,openai_requests:0,checks,plans:[]};
try{
 await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));
 const oldHistory=await data(db.from('setup_evaluation_events').select('id,status,payload').order('id'));
 const account=await data(db.rpc('bootstrap_demo_account',{p_idempotency_key:randomUUID(),p_name:'EDGE V1 live acceptance · synthetic',p_equity:'10000',p_balance:'10000'}));report.account_id=account;
 await data(db.rpc('create_risk_version',{p_account_id:account,p_config:{maxRiskPercent:'0.5',maxDailyTrades:10,minRR:'3',rrPolicy:'BLOCK',newsPolicy:'BLOCK',dailyRiskCap:null,dailyLossCap:null},p_immediate:true,p_reason:'Dedicated synthetic acceptance account: allow three controlled fixtures.'}));
 const risk=await data(db.from('risk_plan_versions').select('id').eq('account_id',account).order('created_at',{ascending:false}).limit(1).single());
 const obs=await data(db.from('account_observations').select('id').eq('account_id',account).single());
 const ins=await data(db.from('instrument_versions').select('id').eq('account_id',account).eq('symbol','EURUSD').single());
 assert.ok((await html(`/edge?account=${account}`)).includes('No completed trades yet.'));checks.push('New test account shows the useful empty EDGE state');
 for(const [n,entry,exit,model,result] of [[0,'1.1','1.104','OB_FIRST_TOUCH',2],[1,'1.11','1.108','OTE',-1],[2,'1.12','1.12','OB_FIRST_TOUCH',0]]){
  const p={instrumentId:ins.id,direction:'LONG',model,entry,stop:(Number(entry)-0.002).toFixed(3),target:(Number(entry)+0.006).toFixed(3),riskPercent:'0.5',narrative:'Synthetic EDGE acceptance fixture, not a market claim.',contractConfirmed:true,news:'CLEAR',contradiction:false};
  const proposal=await data(db.rpc('save_setup_proposal',{p_account_id:account,p_key:randomUUID(),p_expected_risk_id:risk.id,p_expected_observation_id:obs.id,p_proposal:p}));
  const locked=await data(db.rpc('check_setup_risk',{p_proposal_id:proposal,p_lock:true}));assert.equal(locked.result.decision,'APPROVED','Live clock must be risk-eligible');assert.ok(locked.planId);report.plans.push(locked.planId);
  await data(db.rpc('record_setup_decision',{p_proposal_id:proposal,p_decision:'TAKEN',p_reason:'Synthetic acceptance execution'}));
  const persistedLock=await data(db.from('trade_plans').select('locked_at').eq('id',locked.planId).single());
  await submitJournal(locked.planId,'open',{entry,quantity:'0.25',enteredAt:persistedLock.locked_at});
  assert.equal((await data(db.from('journal_analytics').select('status').eq('id',locked.planId).single())).status,'TAKEN');
  await submitJournal(locked.planId,'close',{exit,exitedAt:persistedLock.locked_at,fees:'0'});
  const row=await data(db.from('journal_analytics').select('*').eq('id',locked.planId).single());assert.equal(Number(row.realized_r),result);assert.equal(row.status,'CLOSED');
  const page=await html(`/journal/${locked.planId}`);assert.ok(page.includes(`${result>0?"+":""}${result.toFixed(2)}R`));assert.ok(page.includes('TRADE CLOSED'));
  if(n===0)await submitJournal(locked.planId,'tags',{grade:'A',liquidity:'PDH',mss:'M5'});
 }
 checks.push('Three real create → lock → taken → Journal entry form → Journal close form flows: +2R, −1R, 0R; OB and OTE');
 const rows=await data(db.from('journal_analytics').select('*').eq('account_id',account));assert.equal(rows.length,3);assert.equal(rows.reduce((s,t)=>s+Number(t.realized_r),0),1);
 const edge=await html(`/edge?account=${account}`);for(const s of ['33.33%','0.33R','1.00R','2.00','N = 3','Equity curve','Entry model','Original strategy version','Entry session','Entry weekday'])assert.ok(edge.includes(s),s);
 checks.push('EDGE renders correct net R, expectancy, win rate, profit factor, drawdown, sample size, equity curve and breakdowns');
 const ote=await html(`/edge?account=${account}&model=OTE`);assert.ok(ote.includes('-1.00R'));assert.ok(ote.includes('N = 1'));checks.push('OB/OTE filter applies to metrics and chart');
 const journal=await html(`/journal?account=${account}&status=CLOSED`);assert.ok(journal.includes('+2.00R')&&journal.includes('-1.00R')&&journal.includes('0.00R'));checks.push('Completed Journal filter and refresh preserve outcomes');
 const csvResponse=await fetch(`${base}/edge/export?account=${account}&model=OTE`,{headers:headers()});assert.equal(csvResponse.status,200);assert.ok(csvResponse.headers.get('cache-control').includes('private'));assert.ok(csvResponse.headers.get('cache-control').includes('no-store'));const csv=await csvResponse.text();assert.equal(csv.split('\r\n').length,2);assert.ok(csv.includes('"OTE"'));assert.ok(!csv.includes(users[1].id));checks.push('Filtered CSV export contains one OTE record without authentication identifiers');
 assert.deepEqual(await data(db.from('setup_evaluation_events').select('id,status,payload').order('id')),oldHistory);checks.push('Existing AI evaluation history is unchanged');
 await db.auth.signOut({scope:'local'});jar.clear();const anonymous=await fetch(`${base}/edge`,{headers:headers()});assert.ok(anonymous.url.includes('/login'));assert.equal((await fetch(`${base}/edge/export`)).status,401);
 await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));assert.ok((await html(`/edge?account=${account}`)).includes('0.33R'));checks.push('Sign-out blocks EDGE/export; sign-in restores identical persisted results');
 await db.auth.signOut({scope:'local'});jar.clear();await data(db.auth.signInWithPassword({email:users[0].email,password:users[0].password}));
 for(const table of ['trade_executions','trade_outcomes','trade_tag_revisions','trade_dispositions','journal_analytics'])assert.deepEqual(await data(db.from(table).select('*').eq('account_id',account)),[]);
 assert.ok((await db.rpc('close_journal_trade',{p_plan_id:report.plans[0],p_exit:'1.1',p_exited_at:new Date().toISOString(),p_fees:'0'})).error);checks.push('Live two-user RLS hides every new table and the view; foreign close is rejected');
 await db.auth.signOut({scope:'local'});jar.clear();await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));
 const historical=await data(db.from('accounts').select('id').eq('name','EDGE V1 historical fixtures · SYNTHETIC').single());report.historical_account_id=historical.id;
 const historyRows=await data(db.from('journal_analytics').select('*').eq('account_id',historical.id).order('entered_at'));assert.deepEqual(historyRows.map(t=>Number(t.realized_r)),[2,-1,0,3]);assert.equal(new Set(historyRows.map(t=>t.strategy_version_id)).size,2);
 const historicalEdge=await html(`/edge?account=${historical.id}`);for(const value of ['4.00R','1.00R','50.00%','5.00','N = 4'])assert.ok(historicalEdge.includes(value),value);
 for(const [session,weekday,r] of [['JUDAS','Tuesday',2],['ASIAN_RANGE','Wednesday',-1],['ACTIVE_KILL_ZONE','Thursday',0],['DEAD_POOL','Friday',3]]){
  const response=await fetch(`${base}/edge/export?account=${historical.id}&session=${session}&weekday=${weekday}`,{headers:headers()});assert.equal(response.status,200);const text=await response.text();assert.equal(text.split('\r\n').length,2,session);assert.ok(text.includes(`"${session}"`));assert.ok(text.includes(`"${weekday}"`));assert.ok((await html(`/edge?account=${historical.id}&session=${session}`)).includes(`${r.toFixed(2)}R`));
 }
 const v1=historyRows[0].strategy_version_id;const versionPage=await html(`/edge?account=${historical.id}&strategy=${v1}`);assert.ok(versionPage.includes('0.50R'));assert.ok(versionPage.includes('N = 2'));
 const dated=await fetch(`${base}/edge/export?account=${historical.id}&from=2026-09-02&to=2026-09-03`,{headers:headers()});assert.equal((await dated.text()).split('\r\n').length,3);
 checks.push('Four explicitly synthetic historical fixtures verify Judas/Asia/active/Dead Pool, Tuesday–Friday, two original strategy versions and date-filtered CSV');
 report.completed=true;
}catch(e){report.error=e instanceof Error?e.message:'Verification failed';process.exitCode=1;}finally{await db.auth.signOut({scope:'local'});writeFileSync('docs/EDGE_LIVE_VERIFICATION.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report,null,2));}





