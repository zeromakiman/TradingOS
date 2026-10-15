// Local-only native PostgreSQL test. Optional tools live in ignored .local/ai-budget-tools.
// Never loads .env.local or accepts a remote connection string.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,mkdtempSync,cpSync,unlinkSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const requireTools=createRequire(resolve('.local/ai-budget-tools/package.json'));
const {Client}=requireTools('pg');
const pgPackage=resolve('.local/ai-budget-tools/node_modules/.pnpm');
const nativePackage=readdirSync(pgPackage).find(n=>n.startsWith('@embedded-postgres+windows-x64@'));
assert.ok(nativePackage,'Install local test tools as described in docs/AI_BUDGET_REVIEW.md');
const packageBin=await import(pathToFileURL(join(pgPackage,nativePackage,'node_modules/@embedded-postgres/windows-x64/dist/index.js')));
// Native Windows PostgreSQL cannot re-exec from this workspace's Unicode path.
const dir=mkdtempSync(join(tmpdir(),'trading-ai-resolution-')),password=randomBytes(32).toString('hex');
assert.match(dir,/^[\x20-\x7e]+$/,'Native test directory must have an ASCII path');
cpSync(dirname(dirname(packageBin.postgres)),join(dir,'native'),{recursive:true});
const bin={initdb:join(dir,'native/bin/initdb.exe'),pg_ctl:join(dir,'native/bin/pg_ctl.exe')};
const passwordFile=join(dir,'init-password');writeFileSync(passwordFile,password);
function command(binary,args){return new Promise((resolveCommand,reject)=>{const p=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('error',reject);p.on('exit',code=>code===0?resolveCommand():reject(new Error(`Local PostgreSQL command failed: ${output.replaceAll(password,'[REDACTED]')}`)));});}
const config={host:'127.0.0.1',port:54330,user:'postgres',password,database:'postgres'};
const clients=[];let started=false;
async function connect(user=config.user){const c=new Client({...config,user});await c.connect();clients.push(c);return c;}
const owner='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
async function actor(c,id=owner,role='authenticated'){await c.query(`reset role;set role ${role}`);await c.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
try{
 await command(bin.initdb,['-D',join(dir,'data'),'-U','postgres','--auth=scram-sha-256',`--pwfile=${passwordFile}`,'--encoding=UTF8','--locale=C']);unlinkSync(passwordFile);
 await command(bin.pg_ctl,['-D',join(dir,'data'),'-l',join(dir,'postgres.log'),'-o','-h 127.0.0.1 -p 54330','-w','start']);started=true;
 const admin=await connect();
 await admin.query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;insert into auth.users values('${owner}'),('${other}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
 for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(`supabase/migrations/${f}`,'utf8'));
 await admin.query(`create role incident_operator_test login password '${password}';grant ai_accounting_operator to incident_operator_test;create role ordinary_test login password '${password}';grant authenticated to ordinary_test;`);
 const operators=await Promise.all([connect('incident_operator_test'),connect('incident_operator_test')]);
 const ordinary=await connect('ordinary_test');
 const resolveSql='select private.resolve_ai_uncertainty($1,$2,$3,$4,$5,$6::jsonb)';
 const decision=(id,key=randomUUID())=>[key,id,'NO_PROVIDER_USAGE_CONFIRMED','Synthetic provider incident investigation','SYNTHETIC-INCIDENT','{}'];
 async function incident(){
  await actor(admin);const a=(await admin.query("select public.bootstrap_demo_account($1,'Resolution synthetic','10000','10000') id",[randomUUID()])).rows[0].id;
  await admin.query('select public.set_account_ai_preferences($1,true,100,true)',[a]);
  await actor(admin,owner,'service_role');const id=randomUUID();
  await admin.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-6-astra','{}',792000,'REVIEW_TRADE','openai')",[id,owner,a,randomUUID(),'a'.repeat(64)]);
  await admin.query('select public.dispatch_account_ai_request($1,$2,$3)',[id,owner,'a'.repeat(64)]);
  await admin.query("select public.settle_account_ai_request($1,$2,'{\"disposition\":\"UNCERTAIN\",\"chargedMicros\":792000,\"errorCode\":\"RATE_LIMIT\"}')",[id,owner]);return {a,id};
 }
 const first=await incident();
 await assert.rejects(ordinary.query(resolveSql,decision(first.id)),/permission/);
 const races=await Promise.allSettled(operators.map(c=>c.query(resolveSql,decision(first.id))));
 assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(races.filter(x=>x.status==='rejected'&&/already resolved/.test(x.reason.message)).length,1);
 await actor(admin);assert.equal((await admin.query('select public.get_account_ai_budget($1) value',[first.a])).rows[0].value.usedMicros,0);
 assert.equal((await admin.query('select resolver from public.ai_uncertainty_resolutions where reservation_id=$1',[first.id])).rows[0].resolver,'incident_operator_test');
 const second=await incident(),key=randomUUID();
 await operators[0].query('begin');await operators[0].query(resolveSql,decision(second.id,key));
 const workers=await Promise.all(Array.from({length:4},()=>connect()));await Promise.all(workers.map(c=>actor(c,owner,'service_role')));
 let completed=0;
 const pending=workers.map(c=>c.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-5.4-mini','{}',600000,'SYNTHETIC_CONCURRENCY','openai')",[randomUUID(),owner,second.a,randomUUID(),'a'.repeat(64)]).then(()=>{completed++;return {ok:true};},e=>{completed++;return {ok:false,error:e.message};}));
 // Inspect lock waiters rather than relying on timing as proof of serialization.
 await admin.query('reset role');let blocked=0;
 for(let i=0;i<100;i++){blocked=Number((await admin.query("select count(*) n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select public.reserve_account_ai_request%'")).rows[0].n);if(blocked===4)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(blocked,4);assert.equal(completed,0);await operators[0].query('commit');
 const outcomes=await Promise.all(pending);assert.equal(outcomes.filter(x=>x.ok).length,1);assert.equal(outcomes.filter(x=>!x.ok&&/Insufficient/.test(x.error)).length,3);
 await operators[0].query(resolveSql,decision(second.id,key));
 await actor(admin);const state=(await admin.query('select public.get_account_ai_budget($1) value',[second.a])).rows[0].value;
 assert.equal(state.heldMicros,600000);assert.equal(state.usedMicros,0);assert.equal(state.uncertain,false);
 const report={checkedAt:new Date().toISOString(),freshMigrations:'0001-0014',nativePostgres:true,operatorLoginIdentityVerified:true,ordinaryLoginDenied:true,concurrentTerminalDecisions:{accepted:1,rejected:1},reservationsWaitedForResolution:blocked,postResolutionReservations:{accepted:1,rejected:3,heldMicros:600000,capMicros:1000000},idempotentReplay:true,providerCalls:0,remoteDatabaseConnections:0};
 writeFileSync('.local/AI_RESOLUTION_CONCURRENCY.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report,null,2));
}finally{if(existsSync(passwordFile))unlinkSync(passwordFile);await Promise.allSettled(clients.map(c=>c.end()));if(started)await command(bin.pg_ctl,['-D',join(dir,'data'),'-m','fast','-w','stop']);}
