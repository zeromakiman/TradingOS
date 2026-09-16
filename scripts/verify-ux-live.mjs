// Read-only acceptance against the real local app and isolated Supabase test user.
// Does not import the AI provider or enable AI. No OpenAI requests or billed APIs.
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServerClient} from '@supabase/ssr';
loadEnvFile('.env.local');
assert.equal(process.env.AI_ENABLED,'false');
const {users,project}=JSON.parse(readFileSync('.local/integration-users.json','utf8'));
assert.equal(project,process.env.NEXT_PUBLIC_SUPABASE_URL);
const account=process.argv[2],plan=process.argv[3];
assert.match(account??'',/^[a-f0-9-]{36}$/);assert.match(plan??'',/^[a-f0-9-]{36}$/);
const base='http://127.0.0.1:3000',jar=new Map(),checks=[];
const db=createServerClient(project,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:values=>values.forEach(c=>{jar.set(c.name,c.value);})}});
const headers=()=>({Origin:base,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')});
async function data(q){const r=await q;if(r.error)throw Error(r.error.message);return r.data;}
async function page(path){const r=await fetch(base+path,{headers:headers()});assert.equal(r.status,200);const html=(await r.text()).replace(/<!--[\s\S]*?-->/g,'');assert.ok(!html.includes('Workspace unavailable.'),path);return html;}
await data(db.auth.signInWithPassword({email:users[1].email,password:users[1].password}));
checks.push('Real Supabase password authentication succeeds');
const before=await data(db.from('setup_evaluation_events').select('id,status,payload').order('id'));
const row=await data(db.from('journal_analytics').select('*').eq('id',plan).single());assert.equal(row.account_id,account);assert.equal(row.status,'CLOSED');assert.equal(Number(row.realized_r),2);
assert.ok((await page(`/today?account=${account}`)).includes('+2.00R'));checks.push('Today displays the persisted daily +2R result');
const journal=await page(`/journal?account=${account}`);assert.ok(journal.includes('+2.00R')&&journal.includes('1 matching'));checks.push('Paginated Journal loads the preserved risk and realized result');
for(const [query,count] of [['status=CLOSED',1],['outcome=WIN',1],['outcome=LOSS',0],['q=EURUSD',1],['q=GBPUSD',0],[`q=${plan}`,1],['model=OTE',0],['from=2026-09-07&to=2026-09-07',1],['from=2026-09-08',0],['strategy=ICT%20V1.0',1]])assert.ok((await page(`/journal?account=${account}&${query}`)).includes(`${count} matching`),query);
checks.push('Database-backed status, outcome, instrument/ID search, model, strategy and UTC−5 date filters');
const detail=await page(`/journal/${plan}`);for(const text of ['Planned · original locked values','Actual execution &amp; outcome','+2.00R','NOTE ADDED','Private screenshots'])assert.ok(detail.includes(text),text);
checks.push('Trade detail keeps the original plan, execution, screenshot and note after a fresh session');
const linked=await data(db.from('setup_locks').select('proposal_id').eq('plan_id',plan).single());
const image=await data(db.from('setup_screenshots').select('id').eq('proposal_id',linked.proposal_id).single());
const privateImage=await fetch(`${base}/api/screenshots/${image.id}`,{headers:headers()});assert.equal(privateImage.status,200);assert.ok(privateImage.headers.get('cache-control').includes('private'));assert.ok(privateImage.headers.get('content-type').startsWith('image/'));assert.ok((await privateImage.arrayBuffer()).byteLength>0);
const anonymous=await fetch(`${base}/api/screenshots/${image.id}`);assert.equal(anonymous.status,401);checks.push('Authenticated screenshot bytes load; anonymous access is denied');
const disabled=await fetch(`${base}/api/setups/${linked.proposal_id}/analyze`,{method:'POST',headers:headers()});assert.equal(disabled.status,200);assert.equal((await disabled.json()).status,'DISABLED');assert.deepEqual(await data(db.from('setup_evaluation_events').select('id,status,payload').order('id')),before);
checks.push('Disabled Analyze returns a normal response and creates no evaluation history');
const csv=await fetch(`${base}/edge/export?account=${account}`,{headers:headers()});assert.equal(csv.status,200);assert.ok(csv.headers.get('cache-control').includes('private'));const exported=await csv.text();assert.equal(exported.split("\r\n").length,2);assert.ok(exported.includes('"EURUSD"')&&exported.includes('"WIN"')&&exported.includes('"1.10400"'));assert.ok(!exported.includes(plan));checks.push('Authenticated CSV contains the tested trade and stays private');
await db.auth.signOut({scope:"local"});checks.push('Test API session signed out');
writeFileSync('docs/UX_V1_1_LIVE_VERIFICATION.json',JSON.stringify({verified_at:new Date().toISOString(),completed:true,openai_requests:0,account_id:account,plan_id:plan,checks},null,2)+'\n');
console.log(`PASS: ${checks.length} live acceptance groups. No OpenAI calls.`);
