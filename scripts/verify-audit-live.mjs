// Real isolated-user security checks. No provider imports or OpenAI network access.
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {createServerClient} from '@supabase/ssr';
process.env.AI_ENABLED='false';process.env.OPENAI_API_KEY='';loadEnvFile('.env.local');
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));
assert.equal(project,process.env.NEXT_PUBLIC_SUPABASE_URL);
const base='http://127.0.0.1:3000',key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const originalFetch=globalThis.fetch;let forbidden=0;
globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(![new URL(project).hostname,'127.0.0.1'].includes(u.hostname)){forbidden++;throw Error('Unexpected network destination');}return originalFetch(input,init);};
const clients=users.map(()=>{const jar=new Map();return {jar,db:createServerClient(project,key,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>cs.forEach(c=>{jar.set(c.name,c.value);})}})};});
const headers=n=>({Origin:base,Cookie:[...clients[n].jar].map(([k,v])=>`${k}=${v}`).join('; ')});
async function data(q){const r=await q;assert.equal(r.error,null,r.error?.code??'query failed');return r.data;}
const checks=[],report={started_at:new Date().toISOString(),completed:false,checks,openai_requests:0};
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const tables=['accounts','account_observations','strategy_versions','risk_plan_versions','instrument_versions','risk_evaluations','trade_plans','trade_events','configuration_events','daily_contexts','chart_assets','plan_chart_assets','ai_analysis_attempts','trade_reviews','strategy_experiments','experiment_reviews','bootstrap_requests','setup_proposals','setup_locks','setup_risk_checks','setup_screenshots','setup_screenshot_removals','setup_evaluations','setup_evaluation_screenshots','setup_evaluation_events','setup_evaluation_passes','setup_human_decisions','trade_executions','trade_outcomes','trade_dispositions','trade_tag_revisions'];
try{
 for(let n=0;n<2;n++)await data(clients[n].db.auth.signInWithPassword({email:users[n].email,password:users[n].password}));
 await check('Both isolated users authenticate',async()=>{for(let n=0;n<2;n++)assert.equal((await data(clients[n].db.auth.getUser())).user.id,users[n].id);});
 for(const table of tables)await check(`${table}: cross-user SELECT and direct INSERT/UPDATE/DELETE denied`,async()=>{
  for(let n=0;n<2;n++){const db=clients[n].db;assert.deepEqual(await data(db.from(table).select('user_id').eq('user_id',users[1-n].id)),[]);for(const q of [db.from(table).insert({user_id:users[1-n].id}),db.from(table).update({user_id:users[1-n].id}).eq('user_id',users[1-n].id),db.from(table).delete().eq('user_id',users[1-n].id)])assert.equal((await q).error?.code,'42501');}
 });
 const [a,b]=clients.map(x=>x.db);
 const p=(await data(b.from('trade_plans').select('id,account_id,proposal').order('locked_at').limit(1).single()));
 const image=await data(b.from('setup_screenshots').select('id,proposal_id,storage_path').order('uploaded_at').limit(1).single());
 report.fixture={plan_id:p.id,account_id:p.account_id,screenshot_id:image.id};
 await check('Cross-user plan, setup and screenshot URLs disclose no record',async()=>{
  for(const path of [`/journal/${p.id}`,`/analyze/${image.proposal_id}`,`/api/screenshots/${image.id}`]){const r=await fetch(base+path,{headers:headers(0)});const html=await r.text();if(path.startsWith('/api/'))assert.equal(r.status,404,path);else {assert.ok(r.status===404||(r.status===200&&html.includes('NEXT_HTTP_ERROR_FALLBACK;404')),path+' must render not-found');assert.ok(!html.includes(p.proposal.narrative),'Foreign narrative must not leak');}}
 });
 await check('Anonymous and stale sessions cannot load private pages or exports',async()=>{
  for(const cookie of ['',`sb-${new URL(project).hostname.split('.')[0]}-auth-token=invalid-session`])for(const path of ['/today','/analyze','/journal','/edge','/settings']){const r=await fetch(base+path,{headers:cookie?{cookie}:{},redirect:'manual'});assert.equal(r.status,307);assert.ok(r.headers.get('location').includes('/login'));}
  for(const path of ['/edge/export',`/api/screenshots/${image.id}`])assert.equal((await fetch(base+path)).status,401);
 });
 await check('Signed-in non-AI pages render without an OpenAI key',async()=>{
  const pages=[['/today','Your trading day.'],['/analyze','Build a deliberate trade.'],['/journal','Your decision record.'],['/edge','Measure the record.'],['/settings','Settings'],[`/journal/${p.id}`,'Events &amp; audit history'],[`/analyze/${image.proposal_id}`,'Chart evidence']];
  for(const [path,expected] of pages){const r=await fetch(base+path,{headers:headers(1)});assert.equal(r.status,200,path);const html=await r.text();assert.ok(!html.includes('Workspace unavailable.'),path);assert.ok(html.includes(expected),path+' must render its actual content, not a streamed error');}
 });
 await check('Private bucket and object listing/download isolation',async()=>{
  const admin=createClient(project,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});const bucket=await data(admin.storage.getBucket('setup-screenshots'));assert.equal(bucket.public,false);assert.equal(bucket.file_size_limit,4194304);
  assert.ok((await a.storage.from('setup-screenshots').download(image.storage_path)).error);assert.deepEqual(await data(a.storage.from('setup-screenshots').list(users[1].id)),[]);
  const fake=users[0].id+'/'+randomUUID();assert.ok((await a.storage.from('setup-screenshots').upload(fake,new Uint8Array([1,2,3]),{contentType:'image/png'})).error);
  const r=await fetch(`${base}/api/screenshots/${image.id}`,{headers:headers(1)});assert.equal(r.status,200);assert.ok(r.headers.get('cache-control').includes('private'));assert.ok((await r.arrayBuffer()).byteLength>0);
  const pub=await fetch(`${project}/storage/v1/object/public/setup-screenshots/${image.storage_path}`);assert.ok(pub.status>=400);
 });
 await check('Foreign ownership cannot be supplied to privileged upload or journal RPCs',async()=>{
  const upload=await fetch(`${base}/api/setups/${image.proposal_id}/screenshots`,{method:'POST',headers:headers(0),body:'invalid'});assert.equal(upload.status,404);
  for(const [fn,args] of [['open_journal_trade',{p_plan_id:p.id,p_entry:'1.1',p_quantity:'0.25',p_entered_at:new Date().toISOString()}],['close_journal_trade',{p_plan_id:p.id,p_exit:'1.104',p_exited_at:new Date().toISOString(),p_fees:'0'}],['set_journal_disposition',{p_plan_id:p.id,p_status:'CANCELLED',p_reason:'Unauthorized audit attempt'}],['remove_setup_screenshot',{p_screenshot_id:image.id}],['check_setup_risk',{p_proposal_id:image.proposal_id,p_lock:true}]])assert.ok((await a.rpc(fn,args)).error,fn);
 });
 await check('Disabled Analyze creates no evaluations and preserves previous failed history',async()=>{
  const before=await data(b.from('setup_evaluation_events').select('id,status,payload').order('id'));assert.ok(before.some(e=>e.status==='FAILED'));
  const r=await fetch(`${base}/api/setups/${image.proposal_id}/analyze`,{method:'POST',headers:headers(1)});assert.equal(r.status,200);assert.equal((await r.json()).status,'DISABLED');assert.deepEqual(await data(b.from('setup_evaluation_events').select('id,status,payload').order('id')),before);
 });
 await check('Filtered CSV remains private and excludes authentication identifiers',async()=>{
  const r=await fetch(`${base}/edge/export?account=${p.account_id}`,{headers:headers(1)});assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes(users[1].id));assert.ok(!text.includes('account_id'));assert.ok(r.headers.get('cache-control').includes('private'));
 });
 if(!process.argv.includes('--pre-migration'))await check('Concurrent keyed note retries append one immutable event',async()=>{const k=randomUUID(),args={p_plan_id:p.id,p_note:'SYNTHETIC pre-deployment audit: concurrent note retry',p_request_key:k};const first=await Promise.all([b.rpc('append_plan_note',args),b.rpc('append_plan_note',args)]);first.forEach(r=>{assert.equal(r.error,null);});assert.equal(first[0].data,first[1].data);assert.equal((await data(b.from('trade_events').select('id').eq('request_key',k))).length,1);assert.ok((await b.rpc('append_plan_note',{...args,p_note:'Changed retry'})).error);assert.ok((await a.rpc('append_plan_note',args)).error);});
 await check('No forbidden or OpenAI request attempted',async()=>assert.equal(forbidden,0));report.completed=true;
}catch(e){report.failure=e instanceof Error?e.message:'Audit failed';process.exitCode=1;console.log('FAIL '+report.failure);}
finally{await Promise.allSettled(clients.map(c=>c.db.auth.signOut({scope:'local'})));writeFileSync('docs/PREDEPLOY_LIVE_VERIFICATION.json',JSON.stringify(report,null,2)+'\n');}

