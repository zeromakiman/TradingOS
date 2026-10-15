// Actual Settings component + server actions, synthetic session adapter and local PostgreSQL (PGlite).
// Does not load any env file, Supabase credentials, production data or AI provider.
import {createServer} from 'node:http';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const localRequire=createRequire(resolve('.local/ai-budget-tools/package.json')),{build}=localRequire('esbuild');
const output=resolve('.local/ai-budget-browser');mkdirSync(output,{recursive:true});
const owner='10000000-0000-4000-8000-000000000001';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;insert into auth.users values('${owner}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(`supabase/migrations/${f}`,'utf8'));
await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
const accountId=(await db.query("select public.bootstrap_demo_account($1,'Local AI budget browser test','10000','10000') id",[randomUUID()])).rows[0].id;
let scenario='available';
const availability=()=>({status:scenario==='disabled'?'DISABLED':'ENABLED',message:scenario==='disabled'?'AI analysis is currently disabled':'AI available in isolated mock configuration',deepEnabled:true});
globalThis.__aiBudgetHarness={availability,auth:async()=>({user:{id:owner},db:{rpc:async(name,args)=>{try{if(name!=='set_account_ai_preferences')throw new Error('Unexpected RPC');await db.query('select public.set_account_ai_preferences($1,$2,$3,$4)',[args.p_account_id,args.p_enabled,args.p_budget_cents,args.p_confirm]);return {error:null};}catch{return {error:{message:'Rejected'}};}}}})};
const fakeModules={
 'server-only':'export {};',
 'next/cache':'export function revalidatePath(){}',
 'next/navigation':'export function unstable_rethrow(){}; export function useRouter(){return {push(){},refresh(){}}}',
 '@/lib/supabase/server':'export async function requireUser(){return globalThis.__aiBudgetHarness.auth()}',
 '@/lib/ai-budget':'export function aiSystemAvailability(){return globalThis.__aiBudgetHarness.availability()}',
};
const plugin=(modules)=>({name:'isolated-harness',setup(b){b.onResolve({filter:/.*/},args=>Object.hasOwn(modules,args.path)?{path:args.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js'}));}});
await build({entryPoints:['src/app/ai-settings-actions.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:`${output}/actions.mjs`,plugins:[plugin(fakeModules)],alias:{'@':resolve('src')}});
const actions=await import(pathToFileURL(`${output}/actions.mjs`));
await build({entryPoints:['src/ai/budget.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:`${output}/budget.mjs`});
const {budgetPresentation}=await import(pathToFileURL(`${output}/budget.mjs`));
await build({entryPoints:['tests/browser/ai-budget-entry.tsx'],bundle:true,platform:'browser',format:'esm',outfile:`${output}/client.js`,jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[plugin({'next/navigation':fakeModules['next/navigation'],'@/app/ai-settings-actions':`async function submit(kind,form){const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,fields:Object.fromEntries(form)})});const result=await response.json();window.dispatchEvent(new Event('fixture-refresh'));return result;}export async function saveAiActivation(state,form){return submit('activation',form)}export async function saveAiBudget(state,form){return submit('budget',form)}`})],alias:{'@':resolve('src')}});
const css=readFileSync('src/app/globals.css','utf8').replace(/^@import .*;\r?\n/gm,'');
// All network destinations used by this harness are loopback; paid API access is forbidden.
const originalFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(!['127.0.0.1','localhost'].includes(u.hostname))throw new Error('External network forbidden in AI browser harness');return originalFetch(input,init);};
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  const url=new URL(req.url,'http://127.0.0.1:3115');
  if(url.pathname==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(`${output}/client.js`));return;}
  if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
  if(url.pathname==='/state'){
   scenario=url.searchParams.get('scenario')??'available';
   const snapshot=(await db.query('select public.get_account_ai_budget($1) value',[accountId])).rows[0].value;
   const events=(await db.query('select * from public.ai_preference_events where account_id=$1 order by id desc limit 12',[accountId])).rows;
   if(scenario==='warning')snapshot.usedMicros=snapshot.budgetCents*8000;
   if(scenario==='warning50')snapshot.usedMicros=snapshot.budgetCents*5000;
   if(scenario==='warning95')snapshot.usedMicros=snapshot.budgetCents*9500;
   if(scenario==='pending'){snapshot.usedMicros=1340000;snapshot.heldMicros=1056000;}
   if(scenario==='reached'){snapshot.enabled=true;snapshot.usedMicros=snapshot.budgetCents*10000;}
   if(scenario==='uncertain')snapshot.uncertain=true;
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accountId,data:{snapshot,presentation:budgetPresentation(snapshot,scenario!=='disabled'),system:availability(),events,reservationMicros:1056000,error:null}}));return;
  }
  if(url.pathname==='/action'&&req.method==='POST'){
   if(req.headers.origin!=='http://127.0.0.1:3115')throw new Error('Local origin required');
   let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Too large');}
   const {kind,fields}=JSON.parse(body),form=new FormData();for(const [k,v] of Object.entries(fields))form.set(k,String(v));
   const result=await(kind==='activation'?actions.saveAiActivation:actions.saveAiBudget)({},form);
   writeFileSync(`${output}/state.json`,JSON.stringify({accountId,preferenceEvents:(await db.query('select * from public.ai_preference_events where account_id=$1',[accountId])).rows,providerCalls:0,productionTouched:false},null,2));
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
  }
  if(url.pathname!=='/'){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trading OS · Local AI Settings test</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>');
 }catch{res.writeHead(400).end('Local test request rejected');}
});
server.listen(3115,'127.0.0.1',()=>console.log('Isolated AI Settings harness ready at http://127.0.0.1:3115/; no production or provider access.'));
