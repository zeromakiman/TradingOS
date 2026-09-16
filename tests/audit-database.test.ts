import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
let db:PGlite;
const owner="10000000-0000-4000-8000-000000000001",other="10000000-0000-4000-8000-000000000002";
async function actor(id=owner,role="authenticated"){await db.exec(`reset role;set role ${role};`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
async function plan(direction="LONG"){
 await actor();const a=(await db.query<{id:string}>("select public.bootstrap_demo_account($1,'EDGE test','10000','10000') id",[randomUUID()])).rows[0].id;
 const i=(await db.query<{id:string}>("select id from public.instrument_versions where account_id=$1 and symbol='EURUSD'",[a])).rows[0].id;
 const r=(await db.query<{id:string}>("select id from public.risk_plan_versions where account_id=$1",[a])).rows[0].id;
 const o=(await db.query<{id:string}>("select id from public.account_observations where account_id=$1",[a])).rows[0].id;
 const p={instrumentId:i,direction,model:"OB_FIRST_TOUCH",entry:"1.1",stop:direction==="LONG"?"1.098":"1.102",target:direction==="LONG"?"1.106":"1.094",riskPercent:"0.5",narrative:"Deterministic synthetic journal test",contractConfirmed:true,news:"CLEAR",contradiction:false};
 const lock=(await db.query<{r:{planId:string}}>("select public.lock_trade_plan($1,$2::jsonb,$3,$4,$5) r",[a,JSON.stringify(p),randomUUID(),r,o])).rows[0].r;
 expect(lock.planId).toBeTruthy();return {a,id:lock.planId};
}
async function open(id:string){return (await db.query<{id:string}>("select public.open_journal_trade($1,'1.1','0.25',clock_timestamp()) id",[id])).rows[0].id;}
async function close(id:string,price="1.104",fees="0"){return (await db.query<{id:string}>("select public.close_journal_trade($1,$2,clock_timestamp(),$3) id",[id,price,fees])).rows[0].id;}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;insert into auth.users values('${owner}'),('${other}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
 for(const f of ["0001_foundation.sql","0002_baseline.sql","0003_persistence.sql","0004_setup_analysis.sql","0005_private_screenshot_storage.sql","0006_edge_outcomes.sql","0007_audit_hardening.sql"])await db.exec(readFileSync(`supabase/migrations/${f}`,"utf8"));
 // This local test database has a deterministic eligible session. Never changes live strategy logic.
 await db.exec("create or replace function private.strategy_session(p_now timestamptz) returns text language sql immutable set search_path='' as $$ select 'ACTIVE_KILL_ZONE'::text $$;");
},30000);
afterAll(async()=>{await db.close();});
describe("pre-deployment database hardening",()=>{
 it("applies all seven migrations and preserves 31 owner policies plus the shared evaluator",async()=>{
  await db.exec("reset role");
  const rows=(await db.query<{relname:string;rls:boolean;read:boolean;write:boolean;anon:boolean;policies:number}>(`select c.relname,c.relrowsecurity rls,has_table_privilege('authenticated',c.oid,'SELECT') read,has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') write,has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,(select count(*)::int from pg_policies p where p.schemaname='public' and p.tablename=c.relname and cmd='SELECT' and roles='{authenticated}' and qual like '%auth.uid()%') policies from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`)).rows;
  expect(rows).toHaveLength(32);for(const r of rows){expect(r).toMatchObject({rls:true,read:true,write:false,anon:false,policies:r.relname==='evaluator_versions'?0:1});}
 });
 it("retries a note once, rejects a changed retry and preserves separate intentional notes",async()=>{
  const p=await plan(),key=randomUUID();
  const note=()=>db.query("select public.append_plan_note($1,'Audit note',$2) id",[p.id,key]);
  expect((await note()).rows).toEqual((await note()).rows);
  await expect(db.query("select public.append_plan_note($1,'Changed',$2)",[p.id,key])).rejects.toThrow(/already used/);
  await db.query("select public.append_plan_note($1,'Audit note',$2)",[p.id,randomUUID()]);
  expect((await db.query("select * from public.trade_events where plan_id=$1 and event_type='NOTE_ADDED'",[p.id])).rows).toHaveLength(2);
  await expect(db.query("select public.append_plan_note($1,'Old unkeyed request')",[p.id])).rejects.toThrow(/permission/);
  await actor(other);await expect(note()).rejects.toThrow(/not found/);
 });
 it("rejects a ninth active screenshot in the database and permits replacing a soft-removed one",async()=>{
  const p=await plan();const proposal=(await db.query<{id:string}>("select public.import_locked_setup($1) id",[p.id])).rows[0].id;
  async function insert(bytes=100){await db.exec('reset role');const id=randomUUID();await db.query(`insert into public.setup_screenshots(id,user_id,account_id,proposal_id,role,storage_path,original_filename,mime_type,byte_size,sha256,width,height) values($1,$2,$3,$4,'H4',$5,'chart.png','image/png',$6,$7,8,8)`,[id,owner,p.a,proposal,`${owner}/${proposal}/${id}`,bytes,'a'.repeat(64)]);return id;}
  const first=await insert();for(let i=1;i<8;i++)await insert();await expect(insert()).rejects.toThrow(/limit reached/);
  await actor();await db.query("select public.remove_setup_screenshot($1)",[first]);await insert();
  expect((await db.query("select * from public.setup_screenshots where proposal_id=$1",[proposal])).rows).toHaveLength(9);
  expect((await db.query("select * from public.setup_screenshot_removals where screenshot_id=$1",[first])).rows).toHaveLength(1);
 });
 it("rejects metadata beyond the production image size even through a privileged insert",async()=>{
  const p=await plan(),proposal=(await db.query<{id:string}>("select public.import_locked_setup($1) id",[p.id])).rows[0].id,id=randomUUID();await db.exec('reset role');
  await expect(db.query(`insert into public.setup_screenshots(id,user_id,account_id,proposal_id,role,storage_path,original_filename,mime_type,byte_size,sha256,width,height) values($1,$2,$3,$4,'H4',$5,'chart.png','image/png',4194305,$6,8,8)`,[id,owner,p.a,proposal,`${owner}/${proposal}/${id}`,'a'.repeat(64)])).rejects.toThrow(/size limit/);
 });
 it("keeps every evidence and outcome relationship attached to the same proposal or plan",async()=>{
  await db.exec('reset role');for(const name of ['evidence_same_proposal','decision_same_proposal','outcome_same_plan']){const row=(await db.query<{convalidated:boolean;definition:string}>("select convalidated,pg_get_constraintdef(oid) definition from pg_constraint where conname=$1",[name])).rows[0];expect(row.convalidated).toBe(true);expect(row.definition).toMatch(/FOREIGN KEY \(user_id, account_id, (proposal_id|plan_id),/);}
 });
 it("blocks foreign execution references and non-finite accounting despite administrator insert access",async()=>{
  const p=await plan();await open(p.id);const execution=(await db.query<{id:string}>("select id from public.trade_executions where plan_id=$1",[p.id])).rows[0].id;
  // Another valid plan in the same account, with distinct geometry.
  const q=(await db.query<{r:{planId:string}}>(`select public.lock_trade_plan(account_id,jsonb_set(jsonb_set(proposal,'{entry}','"1.101"'),'{target}','"1.11"'),$2,risk_plan_version_id,account_observation_id) r from public.trade_plans where id=$1`,[p.id,randomUUID()])).rows[0].r.planId;expect(q).toBeTruthy();await db.exec('reset role');
  await expect(db.query(`insert into public.trade_outcomes(user_id,account_id,plan_id,execution_id,exit_price,exited_at,fees,gross_pnl,net_pnl,realized_r,outcome) values($1,$2,$3,$4,1.104,clock_timestamp(),0,100,100,2,'WIN')`,[owner,p.a,q,execution])).rejects.toThrow(/outcome_same_plan/);
  await expect(db.query(`insert into public.trade_outcomes(user_id,account_id,plan_id,execution_id,exit_price,exited_at,fees,gross_pnl,net_pnl,realized_r,outcome) values($1,$2,$3,$4,1.104,clock_timestamp(),0,'NaN','NaN','NaN','WIN')`,[owner,p.a,p.id,execution])).rejects.toThrow(/finite_outcome/);
 });
 it("still calculates and protects the complete non-AI lifecycle after hardening",async()=>{
  const p=await plan('SHORT');await open(p.id);await close(p.id,'1.096','5');expect((await db.query("select status,realized_r::numeric(10,2)::text,outcome from public.journal_analytics where id=$1",[p.id])).rows[0]).toEqual({status:'CLOSED',realized_r:'1.90',outcome:'WIN'});
  await expect(db.query("update public.trade_plans set nominal_risk=1 where id=$1",[p.id])).rejects.toThrow(/permission/);
  await expect(db.query("select public.close_journal_trade($1,'1.096',clock_timestamp(),'5')",[p.id])).rejects.toThrow(/already closed/);
 });
});
