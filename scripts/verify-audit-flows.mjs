// Supplemental live audit: isolated synthetic writes and cookie refresh. No AI.
// Usage: node scripts/verify-audit-flows.mjs [--users=<file>] [--out=<file>]
//   --users  synthetic users ({"project":…,"users":[{id,email,password},…]}); default .local/integration-users.json
//   --out    report file; default docs/PREDEPLOY_FLOW_VERIFICATION.json (tracked: point local runs under .local/)
// users[1] writes. Screenshots go through the V2 evidence route (docs/V2_ARCHITECTURE.md §3.7, §7.2); the V1 upload
// route POST /api/setups/[id]/screenshots no longer exists. The legacy GET /api/screenshots/[id] is checked only when
// users[1] has a V1 setup_screenshots row (SKIPPED otherwise: V2 never creates one).
import assert from 'node:assert/strict';import {loadEnvFile} from 'node:process';import {readFileSync,writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {createServerClient,createChunks} from '@supabase/ssr';import sharp from 'sharp';
process.env.AI_ENABLED='false';process.env.OPENAI_API_KEY='';loadEnvFile('.env.local');
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3),out=option('out')??'docs/PREDEPLOY_FLOW_VERIFICATION.json';
const {users,project}=JSON.parse(readFileSync(option('users')??'.local/integration-users.json','utf8')),key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,base='http://127.0.0.1:3000',jar=new Map();
const db=createServerClient(project,key,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>cs.forEach(c=>{jar.set(c.name,c.value);})}});
const headers=()=>({Origin:base,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}),checks=[];
async function data(q){const r=await q;assert.equal(r.error,null,r.error?.code??'query failed');return r.data;}
const skipped=[],report={started_at:new Date().toISOString(),completed:false,checks,skipped,openai_requests:0};
async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`);}
function skip(name,reason){skipped.push({name,reason});console.log(`SKIPPED ${name}: ${reason}`);}
try{
 await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));
 await check('Supabase public signup is disabled',async()=>{const r=await fetch(`${project}/auth/v1/settings`,{headers:{apikey:key}});assert.equal(r.status,200);assert.equal((await r.json()).disable_signup,true);});
 const bootstrap={p_idempotency_key:randomUUID(),p_name:`Pre-deployment audit · SYNTHETIC ${new Date().toISOString().slice(0,10)}`,p_equity:'10000',p_balance:'10000'};
 const accounts=await Promise.all([data(db.rpc('bootstrap_demo_account',bootstrap)),data(db.rpc('bootstrap_demo_account',bootstrap))]);assert.equal(accounts[0],accounts[1]);const account=accounts[0];report.account_id=account;checks.push('Concurrent account creation retries return one account');
 const risk=await data(db.from('risk_plan_versions').select('id').eq('account_id',account).single()),obs=await data(db.from('account_observations').select('id').eq('account_id',account).single()),ins=await data(db.from('instrument_versions').select('id').eq('account_id',account).eq('symbol','EURUSD').single());
 const proposal={instrumentId:ins.id,direction:'LONG',model:'OB_FIRST_TOUCH',entry:'1.1',stop:'1.098',target:'1.106',riskPercent:'0.5',narrative:'Synthetic pre-deployment audit; no market claim or real execution.',contractConfirmed:true,news:'CLEAR',contradiction:false};
 const save={p_account_id:account,p_proposal:proposal,p_key:randomUUID(),p_expected_risk_id:risk.id,p_expected_observation_id:obs.id};
 const saves=await Promise.all([data(db.rpc('save_setup_proposal',save)),data(db.rpc('save_setup_proposal',save))]);assert.equal(saves[0],saves[1]);const setup=saves[0];report.proposal_id=setup;checks.push('Concurrent proposal creation retries return one immutable proposal');
 await check('Concurrent lock attempts respect the real strategy clock',async()=>{const results=await Promise.all([data(db.rpc('check_setup_risk',{p_proposal_id:setup,p_lock:true})),data(db.rpc('check_setup_risk',{p_proposal_id:setup,p_lock:true}))]);report.session=results[0].result.session;if(results[0].result.decision==='BLOCKED'){assert.equal(results[1].result.decision,'BLOCKED');assert.ok(results[0].result.issues.some(i=>i.code==='DEAD_POOL'));assert.equal((await data(db.from('trade_plans').select('id').eq('account_id',account))).length,0);report.eligible_lock_race='Not exercised: real clock is in Dead Pool';}else{assert.equal(results[0].planId,results[1].planId);report.plan_id=results[0].planId;report.eligible_lock_race='Same-proposal double lock passed';}});
 if(report.plan_id)await check('Distinct concurrent proposals cannot both reserve the final daily slot',async()=>{
  const proposals=await Promise.all([1.11,1.12].map(entry=>data(db.rpc('save_setup_proposal',{...save,p_key:randomUUID(),p_proposal:{...proposal,entry:entry.toFixed(3),stop:(entry-0.002).toFixed(3),target:(entry+0.006).toFixed(3)}}))));
  const locks=await Promise.all(proposals.map(id=>data(db.rpc('check_setup_risk',{p_proposal_id:id,p_lock:true}))));
  report.last_slot_results=locks.map(x=>({decision:x.result.decision,issues:x.result.issues.map(i=>i.code)}));
  assert.equal(locks.filter(x=>x.result.decision==='APPROVED').length,1);
  assert.equal(locks.filter(x=>x.result.decision==='BLOCKED').length,1);
  assert.ok(locks.find(x=>x.result.decision==='BLOCKED').result.issues.some(i=>i.code==='MAX_TRADES'));
  const plans=await data(db.from('trade_plans').select('id').eq('account_id',account));assert.equal(plans.length,2);
  report.last_slot_race={approved:1,blocked:1,total_reserved_plans:2};
 });
 // V2 evidence (§3.7, §7.2): a Plan Trade draft of the audit account, one client evidenceId per image, at most 24 active
 // screenshots per trade (EVIDENCE_LIMIT → 409, the rejected object removed).
 const draft=await data(db.rpc('create_planned_trade',{p_account_id:account,p_proposal:proposal,p_request_key:randomUUID(),p_expected_risk_id:risk.id,p_expected_observation_id:obs.id}));const trade=draft.tradeId;report.trade_id=trade;
 const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
 const upload=async()=>{const f=new FormData();f.set('evidenceId',randomUUID());f.set('label','HTF');f.set('timeframe','H4');f.set('file',new Blob([new Uint8Array(png)],{type:'image/png'}),'../../synthetic.png');const r=await fetch(`${base}/api/trades/${trade}/evidence`,{method:'POST',headers:headers(),body:f});return {status:r.status,body:await r.json()};};
 let images;
 await check('Twenty-five concurrent uploads admit only twenty-four active screenshots',async()=>{const uploads=await Promise.all(Array.from({length:25},upload));report.upload_statuses=uploads.map(x=>x.status);assert.equal(uploads.filter(x=>x.status===201).length,24);assert.equal(uploads.filter(x=>x.status===409).length,1);images=await data(db.from('trade_evidence').select('id,storage_path').eq('trade_id',trade));assert.equal(images.length,24);assert.ok(images.every(x=>x.storage_path===`${users[1].id}/${trade}/${x.id}`),'Object paths come from the ids, never from the file name');});
 await check('Soft removal preserves private bytes and permits one replacement',async()=>{const id=images[0].id;await data(db.rpc('remove_trade_evidence',{p_evidence_id:id}));assert.equal((await fetch(`${base}/api/evidence/${id}`,{headers:headers()})).status,200);assert.equal((await upload()).status,201);assert.equal((await data(db.from('trade_evidence').select('id').eq('trade_id',trade))).length,25);assert.equal((await upload()).status,409);});
 const legacy=(await data(db.from('setup_screenshots').select('id').order('uploaded_at').limit(1)))[0];
 if(!legacy)skip('Expired cookie metadata refreshes on the legacy image route','users[1] has no V1 setup_screenshots row; V2 never creates one');
 await check('Invalid close data is safely rejected and duplicate closes preserve history',async()=>{const t=await data(db.from('journal_analytics').select('*').eq('status','CLOSED').limit(1).single());const args={p_plan_id:t.id,p_exit:t.exit_price,p_exited_at:t.exited_at,p_fees:t.fees};const before=await data(db.from('trade_events').select('id').eq('plan_id',t.id));const outcomes=await Promise.all([data(db.rpc('close_journal_trade',args)),data(db.rpc('close_journal_trade',args))]);assert.equal(outcomes[0],outcomes[1]);assert.deepEqual(await data(db.from('trade_events').select('id').eq('plan_id',t.id)),before);assert.ok((await db.rpc('close_journal_trade',{...args,p_exit:'NaN'})).error);});
 await check('Expired cookie metadata refreshes on private image and CSV routes',async()=>{
  for(const path of [`/api/evidence/${images[0].id}`,...(legacy?[`/api/screenshots/${legacy.id}`]:[]),'/edge/export']){const login=await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));const session={...login.session,expires_at:Math.floor(Date.now()/1000)-60};const chunks=createChunks(`sb-${new URL(project).hostname.split('.')[0]}-auth-token`,`base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`);const cookie=chunks.map(c=>`${c.name}=${c.value}`).join('; ');const r=await fetch(base+path,{headers:{Origin:base,Cookie:cookie}});assert.equal(r.status,200,path);assert.ok(r.headers.getSetCookie().some(s=>s.startsWith('sb-')),`${path} refresh cookie`);assert.ok(r.headers.get('cache-control').includes('no-store'));}
 });
 report.completed=true;
}catch(e){report.failure=e instanceof Error?e.message:'Verification failed';process.exitCode=1;console.log(`FAIL ${report.failure}`);}finally{await db.auth.signOut({scope:'local'});writeFileSync(out,`${JSON.stringify(report,null,2)}\n`);}
