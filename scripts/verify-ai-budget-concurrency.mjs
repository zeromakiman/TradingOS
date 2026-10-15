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
const dir=mkdtempSync(join(tmpdir(),'trading-ai-budget-')),password=randomBytes(32).toString('hex');
assert.match(dir,/^[\x20-\x7e]+$/,'Native test directory must have an ASCII path');
cpSync(dirname(dirname(packageBin.postgres)),join(dir,'native'),{recursive:true});
const bin={initdb:join(dir,'native/bin/initdb.exe'),pg_ctl:join(dir,'native/bin/pg_ctl.exe')};
const passwordFile=join(dir,'init-password');writeFileSync(passwordFile,password);
function command(binary,args){return new Promise((resolveCommand,reject)=>{const p=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('error',reject);p.on('exit',code=>code===0?resolveCommand():reject(new Error(`Local PostgreSQL command failed: ${output.replaceAll(password,'[REDACTED]')}`)));});}
const config={host:'127.0.0.1',port:54329,user:'postgres',password,database:'postgres'};
const clients=[];let started=false;
async function connect(){const c=new Client(config);await c.connect();clients.push(c);return c;}
const owner='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
async function actor(c,id=owner,role='authenticated'){await c.query(`reset role;set role ${role}`);await c.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
const reserveSql="select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-6-astra','{}',1056000,'SETUP_ANALYSIS','openai')";
const args=a=>[randomUUID(),owner,a,randomUUID(),'a'.repeat(64)];
try{
 await command(bin.initdb,['-D',join(dir,'data'),'-U','postgres','--auth=scram-sha-256',`--pwfile=${passwordFile}`,'--encoding=UTF8','--locale=C']);unlinkSync(passwordFile);
 await command(bin.pg_ctl,['-D',join(dir,'data'),'-l',join(dir,'postgres.log'),'-o','-h 127.0.0.1 -p 54329','-w','start']);started=true;
 const admin=await connect();
 await admin.query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;insert into auth.users values('${owner}'),('${other}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
 for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(`supabase/migrations/${f}`,'utf8'));
 const workers=await Promise.all(Array.from({length:20},()=>connect()));await Promise.all(workers.map(c=>actor(c,owner,'service_role')));
 const cases=[];let a;
 for(const cap of [300,500,1000]){
  await actor(admin);a=(await admin.query("select public.bootstrap_demo_account($1,'Concurrency synthetic','10000','10000') id",[randomUUID()])).rows[0].id;
  await admin.query('select public.set_account_ai_preferences($1,true,$2,true)',[a,cap]);
  const outcomes=await Promise.allSettled(workers.map(c=>c.query(reserveSql,args(a))));
  const accepted=Math.floor(cap*10000/1056000);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,accepted);
  assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.message.includes('Insufficient')).length,20-accepted);
  const held=(await admin.query('select public.get_account_ai_budget($1) value',[a])).rows[0].value.heldMicros;
  assert.equal(held,accepted*1056000);assert.ok(held<=cap*10000);
  cases.push({capMicros:cap*10000,reservationMicros:1056000,accepted,rejected:20-accepted,heldMicros:held});
 }
 // A budget edit holds the same account lock. The concurrent reservation must see the committed OFF value.
 await admin.query('begin');await admin.query('select public.set_account_ai_preferences($1,false,null,false)',[a]);
 const waiting=workers[0].query(reserveSql,args(a)).then(()=>({ok:true}),e=>({ok:false,message:e.message}));
 await admin.query('commit');assert.match((await waiting).message,/OFF/);
 await actor(admin,other);assert.equal((await admin.query('select * from public.ai_request_reservations where account_id=$1',[a])).rowCount,0);
 await assert.rejects(admin.query('select public.set_account_ai_preferences($1,true,10000,true)',[a]),/not found/);
 const report={checkedAt:new Date().toISOString(),nativePostgres:true,connections:20,reservationRequests:60,cases,concurrentOptOutObserved:true,crossUserIsolation:true,productionTouched:false,providerCalls:0};
 writeFileSync('.local/AI_BUDGET_CONCURRENCY.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report,null,2));
}finally{if(existsSync(passwordFile))unlinkSync(passwordFile);await Promise.allSettled(clients.map(c=>c.end()));if(started)await command(bin.pg_ctl,['-D',join(dir,'data'),'-m','fast','-w','stop']);}
