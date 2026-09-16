// Supabase/local-app acceptance only. This script never contacts OpenAI.
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServerClient} from '@supabase/ssr';
import sharp from 'sharp';
loadEnvFile('.env.local');
assert.notEqual(process.env.AI_ENABLED,'true','Disable AI before running this acceptance script.');
const base='http://127.0.0.1:3000',jar=new Map(),checks=[];
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));
assert.equal(project,process.env.NEXT_PUBLIC_SUPABASE_URL);
const db=createServerClient(project,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:values=>{for(const c of values)jar.set(c.name,c.value);}}});
async function data(query){const r=await query;if(r.error)throw Error(r.error.message);return r.data;}
const headers=()=>({Origin:base,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')});
async function get(path){return fetch(`${base}${path}`,{headers:headers()});}
const report={verified_at:new Date().toISOString(),checks,completed:false,openai_requests:0};
try{
 await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));checks.push('Real password sign-in');
 const oldEvents=await data(db.from('setup_evaluation_events').select('id,status,payload').order('id'));
 const oldImages=await data(db.from('setup_screenshots').select('id,storage_path').order('id'));
 const account=await data(db.rpc('bootstrap_demo_account',{p_idempotency_key:randomUUID(),p_name:'AI-disabled acceptance',p_equity:'10000',p_balance:'10000'}));
 const observation=await data(db.from('account_observations').select('id').eq('account_id',account).single());
 const risk=await data(db.from('risk_plan_versions').select('id').eq('account_id',account).single());
 const instrument=await data(db.from('instrument_versions').select('id').eq('account_id',account).eq('symbol','EURUSD').single());
 const proposal=await data(db.rpc('save_setup_proposal',{p_account_id:account,p_key:randomUUID(),p_expected_risk_id:risk.id,p_expected_observation_id:observation.id,p_proposal:{instrumentId:instrument.id,direction:'LONG',model:'OB_FIRST_TOUCH',entry:'1.1',stop:'1.098',target:'1.106',riskPercent:'0.5',narrative:'Synthetic no-AI acceptance plan. No chart facts asserted.',contractConfirmed:true,news:'UNKNOWN',contradiction:false}}));
 report.proposal_id=proposal;checks.push('Account, proposal and persisted risk evaluation');
 const image=await sharp({create:{width:32,height:32,channels:3,background:'#333333'}}).png().toBuffer();
 const form=new FormData();form.set('role','M5');form.set('file',new Blob([image],{type:'image/png'}),'no-ai-test.png');
 const upload=await fetch(`${base}/api/setups/${proposal}/screenshots`,{method:'POST',headers:headers(),body:form});const uploaded=await upload.json();assert.equal(upload.status,201,JSON.stringify(uploaded));
 const imageResponse=await get(`/api/screenshots/${uploaded.id}`);assert.equal(imageResponse.status,200);assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()),image);assert.equal(imageResponse.headers.get('cache-control'),'private, no-store');checks.push('Upload and private image retrieval without AI');
 const deny=await fetch(`${base}/api/screenshots/${uploaded.id}`);assert.equal(deny.status,401);checks.push('Anonymous image access denied');
 const disabled=await fetch(`${base}/api/setups/${proposal}/analyze`,{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({evaluationId:randomUUID(),mode:'NORMAL'})});assert.equal(disabled.status,200);assert.equal((await disabled.json()).status,'DISABLED');assert.deepEqual(await data(db.from('setup_evaluations').select('id').eq('proposal_id',proposal)),[]);checks.push('Direct Analyze request disabled without creating a review');
 const lock=await data(db.rpc('check_setup_risk',{p_proposal_id:proposal,p_lock:true}));assert.equal(lock.result.decision,'APPROVED','Acceptance requires the real eligible strategy session');assert.ok(lock.planId);report.plan_id=lock.planId;checks.push('Fresh deterministic risk check and atomic plan lock');
 await data(db.rpc('append_plan_note',{p_plan_id:lock.planId,p_note:'Audit note while AI is disabled.'}));
 await data(db.rpc('record_setup_decision',{p_proposal_id:proposal,p_decision:'SKIPPED',p_reason:'Synthetic acceptance only.'}));
 assert.deepEqual((await data(db.from('trade_events').select('event_type').eq('plan_id',lock.planId).order('sequence'))).map(x=>x.event_type),['PLAN_LOCKED','NOTE_ADDED']);checks.push('Trade events, appended audit note and human decision');
 for(const path of ['/today','/analyze','/settings','/journal',`/journal/${lock.planId}`,`/analyze/${proposal}`]){const r=await get(path);assert.equal(r.status,200,path);if(path===`/analyze/${proposal}`)assert.ok((await r.text()).includes('AI analysis is currently disabled'));}checks.push('All existing non-AI pages render with the disabled notice');
 assert.deepEqual(await data(db.from('setup_evaluation_events').select('id,status,payload').order('id')),oldEvents);
 for(const old of oldImages){assert.equal((await get(`/api/screenshots/${old.id}`)).status,200);}checks.push('Existing failed evaluation history unchanged and old private screenshots readable');
 await db.auth.signOut({scope:'local'});jar.clear();assert.equal((await get('/journal')).url.includes('/login'),true);await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));assert.equal((await get(`/analyze/${proposal}`)).status,200);checks.push('Sign-out/in and refresh preserve the setup');
 report.completed=true;
}catch(e){report.error=e instanceof Error?e.message:'Acceptance failed';process.exitCode=1;}finally{await db.auth.signOut({scope:'local'});writeFileSync('docs/NON_AI_VERIFICATION.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report,null,2));}
