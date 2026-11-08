// Real isolated-user security checks. No provider imports or OpenAI network access.
// Usage: node scripts/verify-audit-live.mjs [--users=<file>] [--out=<file>] [--ai-enabled] [--pre-migration]
//   --users       synthetic users ({"project":…,"users":[{id,email,password},…]}); default .local/integration-users.json
//   --out         report file; default docs/PREDEPLOY_LIVE_VERIFICATION.json (tracked: point local runs under .local/)
//   --ai-enabled  the deployment runs AI (for example the local stack with its mock provider): the legacy evaluator must
//                 then refuse a request without a valid body; without the flag it must answer DISABLED.
// users[1] owns the records the checks read, from V2 data (docs/V2_ARCHITECTURE.md §2, §3.7): a planned trade with its
// locked plan and proposal, and a V2 screenshot. Legacy V1 rows (setup_screenshots, FAILED setup_evaluation_events)
// exist only on databases that ran V1 and nothing in V2 creates them: the checks that need them print SKIPPED and are
// listed under "skipped" in the report when users[1] has none.
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {createServerClient} from '@supabase/ssr';
process.env.AI_ENABLED='false';process.env.OPENAI_API_KEY='';loadEnvFile('.env.local');
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const usersFile=option('users')??'.local/integration-users.json',out=option('out')??'docs/PREDEPLOY_LIVE_VERIFICATION.json',aiEnabled=process.argv.includes('--ai-enabled');
const {users,project}=JSON.parse(readFileSync(usersFile,'utf8'));
assert.equal(project,process.env.NEXT_PUBLIC_SUPABASE_URL);
const base='http://127.0.0.1:3000',key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const originalFetch=globalThis.fetch;let forbidden=0;
globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(![new URL(project).hostname,'127.0.0.1'].includes(u.hostname)){forbidden++;throw Error('Unexpected network destination');}return originalFetch(input,init);};
const clients=users.map(()=>{const jar=new Map();return {jar,db:createServerClient(project,key,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>cs.forEach(c=>{jar.set(c.name,c.value);})}})};});
const headers=n=>({Origin:base,Cookie:[...clients[n].jar].map(([k,v])=>`${k}=${v}`).join('; ')});
async function data(q){const r=await q;assert.equal(r.error,null,r.error?.code??'query failed');return r.data;}
/** The single row a fixture query must return, with what to seed when it is missing. */
async function fixture(q,what){const rows=await data(q.limit(1));assert.equal(rows.length,1,`users[1] has no ${what}; seed it first (for example scripts/local-stack/seed-v2.mjs)`);return rows[0];}
const checks=[],skipped=[],report={started_at:new Date().toISOString(),completed:false,checks,skipped,ai_enabled_deployment:aiEnabled,openai_requests:0};
async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`);}
function skip(name,reason){skipped.push({name,reason});console.log(`SKIPPED ${name}: ${reason}`);}
const tables=['accounts','account_observations','strategy_versions','risk_plan_versions','instrument_versions','risk_evaluations','trade_plans','trade_events','configuration_events','daily_contexts','chart_assets','plan_chart_assets','ai_analysis_attempts','trade_reviews','strategy_experiments','experiment_reviews','bootstrap_requests','setup_proposals','setup_locks','setup_risk_checks','setup_screenshots','setup_screenshot_removals','setup_evaluations','setup_evaluation_screenshots','setup_evaluation_events','setup_evaluation_passes','setup_human_decisions','trade_executions','trade_outcomes','trade_dispositions','trade_tag_revisions',
 // V2 tenant tables (0015-0018), which hold the records the checks below read.
 'account_profiles','trades','trade_revisions','trade_plan_links','trade_lifecycle_events','trade_position_facts','trade_unplanned_closes','trade_journal_entries','trade_evidence','trade_evidence_removals','trade_evidence_labels','trade_tag_sets','external_loss_entries','external_loss_removals','platform_connections','external_executions','external_execution_closes','platform_connection_events','trade_execution_links','trade_timeline_reviews','trade_timeline_review_results','ai_request_generations'];
try{
 for(let n=0;n<2;n++)await data(clients[n].db.auth.signInWithPassword({email:users[n].email,password:users[n].password}));
 await check('Both isolated users authenticate',async()=>{for(let n=0;n<2;n++)assert.equal((await data(clients[n].db.auth.getUser())).user.id,users[n].id);});
 for(const table of tables)await check(`${table}: cross-user SELECT and direct INSERT/UPDATE/DELETE denied`,async()=>{
  for(let n=0;n<2;n++){const db=clients[n].db;assert.deepEqual(await data(db.from(table).select('user_id').eq('user_id',users[1-n].id)),[]);for(const q of [db.from(table).insert({user_id:users[1-n].id}),db.from(table).update({user_id:users[1-n].id}).eq('user_id',users[1-n].id),db.from(table).delete().eq('user_id',users[1-n].id)])assert.equal((await q).error?.code,'42501');}
 });
 const [a,b]=clients.map(x=>x.db);
 // V2 fixtures: the earliest locked plan, the trade that owns it (the V1 plan and setup links redirect there, §1.2), the
 // proposal of that trade's latest revision, and a V2 screenshot.
 const p=await fixture(b.from('trade_plans').select('id,account_id,proposal').order('locked_at'),'locked plan');
 const trade=(await fixture(b.from('trade_plan_links').select('trade_id').eq('plan_id',p.id),'trade for its locked plan')).trade_id;
 const proposal=(await fixture(b.from('trade_revisions').select('proposal_id').eq('trade_id',trade).order('revision',{ascending:false}),'revision of that trade')).proposal_id;
 const evidence=await fixture(b.from('trade_evidence').select('id,storage_path').order('recorded_at'),'V2 screenshot (trade_evidence)');
 const image=(await data(b.from('setup_screenshots').select('id,proposal_id,storage_path').order('uploaded_at').limit(1)))[0]??null;
 const narrative=p.proposal?.narrative;assert.ok(typeof narrative==='string'&&narrative.trim().length>0,'The fixture plan needs a thesis to check for leaks');
 report.fixture={plan_id:p.id,account_id:p.account_id,trade_id:trade,proposal_id:proposal,evidence_id:evidence.id,legacy_screenshot_id:image?.id??null};
 if(!image)skip('Legacy screenshot isolation (GET /api/screenshots/[id], setup-screenshots bucket objects, remove_setup_screenshot)','users[1] has no V1 setup_screenshots row; V2 never creates one');
 await check('Cross-user plan, setup, trade and screenshot URLs disclose no record',async()=>{
  for(const path of [`/journal/${p.id}`,`/analyze/${proposal}`,`/trades/${trade}`,`/api/evidence/${evidence.id}`,`/api/evidence/${evidence.id}?variant=thumb`,...(image?[`/api/screenshots/${image.id}`]:[])]){const r=await fetch(base+path,{headers:headers(0)});const html=await r.text();if(path.startsWith('/api/'))assert.equal(r.status,404,path);else {assert.ok(r.status===404||(r.status===200&&html.includes('NEXT_HTTP_ERROR_FALLBACK;404')),`${path} must render not-found`);assert.ok(!html.includes(narrative),'Foreign narrative must not leak');}}
 });
 await check('Anonymous and stale sessions cannot load private pages or exports',async()=>{
  for(const cookie of ['',`sb-${new URL(project).hostname.split('.')[0]}-auth-token=invalid-session`])for(const path of ['/today','/analyze','/trades/new',`/trades/${trade}`,'/journal','/edge','/accounts','/review','/settings']){const r=await fetch(base+path,{headers:cookie?{cookie}:{},redirect:'manual'});assert.equal(r.status,307,path);assert.ok(r.headers.get('location').includes('/login'),path);}
  // The routes answer 401 before reading the id, so the legacy route is probed even without a legacy row.
  for(const path of ['/edge/export','/api/export?part=core',`/api/evidence/${evidence.id}`,`/api/screenshots/${image?.id??randomUUID()}`])assert.equal((await fetch(base+path)).status,401,path);
 });
 await check('Signed-in non-AI pages render without an OpenAI key',async()=>{
  // V2 page titles; /analyze opens Plan Trade and the V1 plan and setup links open the trade that owns them.
  const pages=[['/today','<title>Today · Trading OS</title>'],['/analyze','<title>Plan Trade · Trading OS</title>'],['/journal','<title>Journal · Trading OS</title>'],['/edge','<title>EDGE · Trading OS</title>'],['/settings','<title>Settings · Trading OS</title>'],[`/journal/${p.id}`,' · Trade · Trading OS</title>'],[`/analyze/${proposal}`,' · Trade · Trading OS</title>']];
  for(const [path,expected] of pages){const r=await fetch(base+path,{headers:headers(1)});assert.equal(r.status,200,path);const html=await r.text();assert.ok(!html.includes('Workspace unavailable.')&&!/This page couldn(?:'|&#x27;)t load\./.test(html),path);assert.ok(html.includes(expected),`${path} must render its actual content, not a streamed error`);}
 });
 const admin=createClient(project,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 await check('Private bucket and object listing/download isolation',async()=>{
  const bucket=await data(admin.storage.getBucket('setup-screenshots'));assert.equal(bucket.public,false);assert.equal(bucket.file_size_limit,4194304);
  assert.deepEqual(await data(a.storage.from('setup-screenshots').list(users[1].id)),[]);
  const fake=`${users[0].id}/${randomUUID()}`;assert.ok((await a.storage.from('setup-screenshots').upload(fake,new Uint8Array([1,2,3]),{contentType:'image/png'})).error);
  if(image){
   assert.ok((await a.storage.from('setup-screenshots').download(image.storage_path)).error);
   const r=await fetch(`${base}/api/screenshots/${image.id}`,{headers:headers(1)});assert.equal(r.status,200);assert.ok(r.headers.get('cache-control').includes('private'));assert.ok((await r.arrayBuffer()).byteLength>0);
   const pub=await fetch(`${project}/storage/v1/object/public/setup-screenshots/${image.storage_path}`);assert.ok(pub.status>=400);
  }
 });
 await check('Private evidence bucket and object listing/download isolation',async()=>{
  const bucket=await data(admin.storage.getBucket('trade-evidence'));assert.equal(bucket.public,false);assert.equal(bucket.file_size_limit,4194304);
  assert.ok((await a.storage.from('trade-evidence').download(evidence.storage_path)).error);assert.deepEqual(await data(a.storage.from('trade-evidence').list(users[1].id)),[]);
  // Browsers never write to the bucket, not even under their own folder: uploads go through the trusted server route.
  const fake=`${users[0].id}/${randomUUID()}/${randomUUID()}`;assert.ok((await a.storage.from('trade-evidence').upload(fake,new Uint8Array([1,2,3]),{contentType:'image/png'})).error);
  for(const variant of ['','?variant=thumb']){const r=await fetch(`${base}/api/evidence/${evidence.id}${variant}`,{headers:headers(1)});assert.equal(r.status,200,variant);assert.ok(r.headers.get('cache-control').includes('private'),variant);assert.ok((await r.arrayBuffer()).byteLength>0,variant);}
  const pub=await fetch(`${project}/storage/v1/object/public/trade-evidence/${evidence.storage_path}`);assert.ok(pub.status>=400);
 });
 await check('Foreign ownership cannot be supplied to privileged upload, evidence or journal RPCs',async()=>{
  // V2 uploads only through POST /api/trades/[id]/evidence; the V1 upload route no longer exists.
  const upload=await fetch(`${base}/api/trades/${trade}/evidence`,{method:'POST',headers:headers(0),body:'invalid'});assert.equal(upload.status,404);
  assert.equal((await fetch(`${base}/api/setups/${proposal}/screenshots`,{method:'POST',headers:headers(0),body:'invalid'})).status,404);
  const removals=async()=>data(b.from('trade_evidence_removals').select('evidence_id,recorded_at').eq('evidence_id',evidence.id)),labels=async()=>data(b.from('trade_evidence_labels').select('id').eq('evidence_id',evidence.id));const before=[await removals(),await labels()];
  for(const [fn,args] of [['open_journal_trade',{p_plan_id:p.id,p_entry:'1.1',p_quantity:'0.25',p_entered_at:new Date().toISOString()}],['close_journal_trade',{p_plan_id:p.id,p_exit:'1.104',p_exited_at:new Date().toISOString(),p_fees:'0'}],['set_journal_disposition',{p_plan_id:p.id,p_status:'CANCELLED',p_reason:'Unauthorized audit attempt'}],['check_setup_risk',{p_proposal_id:proposal,p_lock:true}],['remove_trade_evidence',{p_evidence_id:evidence.id}],['relabel_trade_evidence',{p_evidence_id:evidence.id,p_label:'OTHER',p_timeframe:null,p_caption:'Unauthorized audit attempt'}],...(image?[['remove_setup_screenshot',{p_screenshot_id:image.id}]]:[])])assert.ok((await a.rpc(fn,args)).error,fn);
  assert.deepEqual([await removals(),await labels()],before,'A refused call must leave the owner\'s screenshot untouched');
 });
 const legacyEvents=async()=>data(b.from('setup_evaluation_events').select('id,status,payload').order('id'));
 const history=await legacyEvents(),failedHistory=history.some(e=>e.status==='FAILED');
 if(!failedHistory)skip('Previous FAILED legacy evaluator history is preserved','users[1] has no FAILED V1 setup_evaluation_events row; V2 never creates one (the no-new-evaluation part still runs)');
 await check(aiEnabled?'Legacy Analyze refuses a request without a valid body and creates no evaluations':`Disabled Analyze creates no evaluations${failedHistory?' and preserves previous failed history':''}`,async()=>{
  const r=await fetch(`${base}/api/setups/${proposal}/analyze`,{method:'POST',headers:headers(1)});
  // With AI on, the route refuses the missing body with 400 before any evaluation starts.
  if(aiEnabled){assert.equal(r.status,400);assert.equal((await r.json()).error,'Send a JSON body with an evaluationId (UUID) and a mode (NORMAL or DEEP).');}else {assert.equal(r.status,200);assert.equal((await r.json()).status,'DISABLED');}
  assert.deepEqual(await legacyEvents(),history);
 });
 await check('Filtered CSV remains private and excludes authentication identifiers',async()=>{
  const r=await fetch(`${base}/edge/export?account=${p.account_id}`,{headers:headers(1)});assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes(users[1].id));assert.ok(!text.includes('account_id'));assert.ok(r.headers.get('cache-control').includes('private'));
 });
 if(!process.argv.includes('--pre-migration'))await check('Concurrent keyed note retries append one immutable event',async()=>{const k=randomUUID(),args={p_plan_id:p.id,p_note:'SYNTHETIC pre-deployment audit: concurrent note retry',p_request_key:k};const first=await Promise.all([b.rpc('append_plan_note',args),b.rpc('append_plan_note',args)]);first.forEach(r=>{assert.equal(r.error,null);});assert.equal(first[0].data,first[1].data);assert.equal((await data(b.from('trade_events').select('id').eq('request_key',k))).length,1);assert.ok((await b.rpc('append_plan_note',{...args,p_note:'Changed retry'})).error);assert.ok((await a.rpc('append_plan_note',args)).error);});
 await check('No forbidden or OpenAI request attempted',async()=>assert.equal(forbidden,0));report.completed=true;
}catch(e){report.failure=e instanceof Error?e.message:'Audit failed';process.exitCode=1;console.log(`FAIL ${report.failure}`);}
finally{await Promise.allSettled(clients.map(c=>c.db.auth.signOut({scope:'local'})));writeFileSync(out,`${JSON.stringify(report,null,2)}\n`);}
