// Explicit opt-in: one paid NORMAL analysis of synthetic, deliberately insufficient chart evidence.
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServerClient} from '@supabase/ssr';
import sharp from 'sharp';
if(!process.argv.includes('--allow-paid'))throw new Error('Opt-in required: pnpm test:ai-live --allow-paid. This submits one paid NORMAL Astra review.');
loadEnvFile('.env.local');
if(process.env.AI_ENABLED!=='true')throw new Error('AI analysis is currently disabled. No API requests were made.');
if(!process.env.OPENAI_API_KEY?.trim())throw new Error('AI API key is missing. No API requests were made.');
const base='http://127.0.0.1:3000',cookies=new Map(),checks=[];
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));
assert.equal(project,process.env.NEXT_PUBLIC_SUPABASE_URL);
const db=createServerClient(project,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>{for(const c of values)cookies.set(c.name,c.value);}}});
async function data(query){const r=await query;if(r.error)throw new Error(r.error.message);return r.data;}
async function post(path,body,json=false){const response=await fetch(`${base}${path}`,{method:'POST',headers:{Origin:base,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(body):body,signal:AbortSignal.timeout(750000)});const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);return result;}
const report={started_at:new Date().toISOString(),mode:'NORMAL',evidence:'Synthetic blank images; validates transport/persistence, not chart-analysis accuracy.',checks,completed:false};
try{
 await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));checks.push('Password sign-in');
 const account=(await data(db.from('accounts').select('id').order('created_at').limit(1).single())).id;
 await data(db.rpc('record_observation',{p_account_id:account,p_equity:'10000',p_balance:'10000',p_gross_loss:null}));
 const observation=await data(db.from('account_observations').select('id').eq('account_id',account).order('recorded_at',{ascending:false}).order('id',{ascending:false}).limit(1).single());
 const risk=await data(db.from('risk_plan_versions').select('id').eq('account_id',account).lte('effective_day',new Date(Date.now()-5*3600000).toISOString().slice(0,10)).order('effective_day',{ascending:false}).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).single());
 const instrument=await data(db.from('instrument_versions').select('id').eq('account_id',account).eq('symbol','EURUSD').single());
 const proposal=await data(db.rpc('save_setup_proposal',{p_account_id:account,p_proposal:{instrumentId:instrument.id,direction:'LONG',model:'OB_FIRST_TOUCH',entry:'1.1',stop:'1.098',target:'1.106',riskPercent:'0.5',narrative:'Synthetic transport smoke test. The images are blank and contain no price action. First touch and all chart facts are unknown.',contractConfirmed:true,news:'UNKNOWN',contradiction:false},p_key:randomUUID(),p_expected_risk_id:risk.id,p_expected_observation_id:observation.id}));
 report.proposal_id=proposal;checks.push('Immutable proposal saved regardless of risk status');
 const image=await sharp({create:{width:512,height:256,channels:3,background:'#222222'}}).png().toBuffer();
 for(const role of ['H4','H1','M15','M5']){const form=new FormData();form.set('role',role);form.set('file',new Blob([image],{type:'image/png'}),`synthetic-blank-${role}.png`);await post(`/api/setups/${proposal}/screenshots`,form);}
 checks.push('Four private screenshots uploaded through real byte-validation routes');
 const id=randomUUID();await post(`/api/setups/${proposal}/analyze`,{evaluationId:id,mode:'NORMAL'},true);report.evaluation_id=id;
 const events=await data(db.from('setup_evaluation_events').select('status,payload').eq('evaluation_id',id));
 const success=events.find(x=>x.status==='COMPLETED');assert.ok(success,JSON.stringify(events));assert.equal(success.payload.result.decision,'INSUFFICIENT_EVIDENCE');checks.push('Live Astra returned validated insufficient evidence');
 const passes=await data(db.from('setup_evaluation_passes').select('stage,status,model,response_id,usage').eq('evaluation_id',id));report.passes=passes;checks.push('Provider model, response ID and token usage persisted');
 assert.equal((await data(db.from('setup_evaluation_screenshots').select('screenshot_id').eq('evaluation_id',id))).length,4);checks.push('Evaluation permanently references its exact four screenshots');
 report.completed=true;
}catch(e){report.error=e instanceof Error?e.message:'Smoke test failed';process.exitCode=1;}finally{
 report.finished_at=new Date().toISOString();writeFileSync('docs/AI_LIVE_VERIFICATION.json',`${JSON.stringify(report,null,2)}\n`);await db.auth.signOut({scope:'local'});
 console.log(JSON.stringify(report,null,2));
}
