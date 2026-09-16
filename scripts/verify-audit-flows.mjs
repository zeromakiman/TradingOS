// Supplemental live audit: isolated synthetic writes and cookie refresh. No AI.
import assert from 'node:assert/strict';import {loadEnvFile} from 'node:process';import {readFileSync,writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {createServerClient,createChunks} from '@supabase/ssr';import sharp from 'sharp';
process.env.AI_ENABLED='false';process.env.OPENAI_API_KEY='';loadEnvFile('.env.local');
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8')),key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,base='http://127.0.0.1:3000',jar=new Map();
const db=createServerClient(project,key,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>cs.forEach(c=>{jar.set(c.name,c.value);})}});
const headers=()=>({Origin:base,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}),checks=[];
async function data(q){const r=await q;assert.equal(r.error,null,r.error?.code??'query failed');return r.data;}
const report={started_at:new Date().toISOString(),completed:false,checks,openai_requests:0};
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
try{
 await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));
 await check('Supabase public signup is disabled',async()=>{const r=await fetch(project+'/auth/v1/settings',{headers:{apikey:key}});assert.equal(r.status,200);assert.equal((await r.json()).disable_signup,true);});
 const bootstrap={p_idempotency_key:randomUUID(),p_name:'Pre-deployment audit · SYNTHETIC '+new Date().toISOString().slice(0,10),p_equity:'10000',p_balance:'10000'};
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
 const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
 const upload=async()=>{const f=new FormData();f.set('role','H4');f.set('file',new Blob([new Uint8Array(png)],{type:'image/png'}),'../../synthetic.png');const r=await fetch(`${base}/api/setups/${setup}/screenshots`,{method:'POST',headers:headers(),body:f});return {status:r.status,body:await r.json()};};
 let images;
 await check('Nine concurrent uploads admit only eight active screenshots',async()=>{const uploads=await Promise.all(Array.from({length:9},upload));report.upload_statuses=uploads.map(x=>x.status);assert.equal(uploads.filter(x=>x.status===201).length,8);assert.equal(uploads.filter(x=>x.status===409).length,1);images=await data(db.from('setup_screenshots').select('id,storage_path').eq('proposal_id',setup));assert.equal(images.length,8);});
 await check('Soft removal preserves private bytes and permits one replacement',async()=>{const id=images[0].id;await data(db.rpc('remove_setup_screenshot',{p_screenshot_id:id}));assert.equal((await fetch(`${base}/api/screenshots/${id}`,{headers:headers()})).status,200);assert.equal((await upload()).status,201);assert.equal((await data(db.from('setup_screenshots').select('id').eq('proposal_id',setup))).length,9);assert.equal((await upload()).status,409);});
 await check('Invalid close data is safely rejected and duplicate closes preserve history',async()=>{const t=await data(db.from('journal_analytics').select('*').eq('status','CLOSED').limit(1).single());const args={p_plan_id:t.id,p_exit:t.exit_price,p_exited_at:t.exited_at,p_fees:t.fees};const before=await data(db.from('trade_events').select('id').eq('plan_id',t.id));const outcomes=await Promise.all([data(db.rpc('close_journal_trade',args)),data(db.rpc('close_journal_trade',args))]);assert.equal(outcomes[0],outcomes[1]);assert.deepEqual(await data(db.from('trade_events').select('id').eq('plan_id',t.id)),before);assert.ok((await db.rpc('close_journal_trade',{...args,p_exit:'NaN'})).error);});
 await check('Expired cookie metadata refreshes on private image and CSV routes',async()=>{
  for(const path of [`/api/screenshots/${images[0].id}`,'/edge/export']){const login=await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));const session={...login.session,expires_at:Math.floor(Date.now()/1000)-60};const chunks=createChunks(`sb-${new URL(project).hostname.split('.')[0]}-auth-token`,'base64-'+Buffer.from(JSON.stringify(session)).toString('base64url'));const cookie=chunks.map(c=>`${c.name}=${c.value}`).join('; ');const r=await fetch(base+path,{headers:{Origin:base,Cookie:cookie}});assert.equal(r.status,200,path);assert.ok(r.headers.getSetCookie().some(s=>s.startsWith('sb-')),path+' refresh cookie');assert.ok(r.headers.get('cache-control').includes('no-store'));}
 });
 report.completed=true;
}catch(e){report.failure=e instanceof Error?e.message:'Verification failed';process.exitCode=1;console.log('FAIL '+report.failure);}finally{await db.auth.signOut({scope:'local'});writeFileSync('docs/PREDEPLOY_FLOW_VERIFICATION.json',JSON.stringify(report,null,2)+'\n');}
