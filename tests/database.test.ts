import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { evaluateRisk, type RiskResult } from "@/domain/risk";
import { previewContext, previewProposal } from "@/domain/fixtures";
import { strategyClock } from "@/domain/session";
import { evaluationEnvelopeSchema, riskReportSchema } from "@/domain/risk-report";

let db:PGlite;
const owner="10000000-0000-4000-8000-000000000001", other="10000000-0000-4000-8000-000000000002";
async function actor(id:string,role="authenticated") { await db.exec(`reset role; set role ${role};`); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); }
async function admin() { await db.exec("reset role"); }
async function account() {
  await actor(owner);
  const {rows} = await db.query<{id:string}>("select public.bootstrap_demo_account($1,'Test account','10000','10000') id",[randomUUID()]);
  const id=rows[0].id;
  const [i,r,o,s] = await Promise.all([
    db.query<{id:string}>("select id from public.instrument_versions where account_id=$1 and symbol='EURUSD'",[id]),
    db.query<{id:string}>("select id from public.risk_plan_versions where account_id=$1",[id]),
    db.query<{id:string}>("select id from public.account_observations where account_id=$1",[id]),
    db.query<{id:string}>("select id from public.strategy_versions where account_id=$1",[id])
  ]);
  return {id,instrumentId:i.rows[0].id,riskId:r.rows[0].id,observationId:o.rows[0].id,strategyId:s.rows[0].id};
}
type Account=Awaited<ReturnType<typeof account>>;
const proposal=(a:Account,changes:Record<string,unknown>={})=>({...previewProposal,instrumentId:a.instrumentId,narrative:"Original pretrade belief",contractConfirmed:true,...changes});
async function lock(a:Account,p=proposal(a),key=randomUUID()) {
  const {rows}=await db.query<{value:{planId:string|null;result:RiskResult;replayed:boolean}}>("select public.lock_trade_plan($1,$2::jsonb,$3,$4,$5) value",[a.id,JSON.stringify(p),key,a.riskId,a.observationId]);
  return rows[0].value;
}
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon; insert into auth.users values('${owner}'),('${other}');`);
  await db.exec(readFileSync("supabase/migrations/0001_foundation.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/0002_baseline.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/0003_persistence.sql","utf8"));
},30000);
afterAll(async()=>{await db.close();});
describe("PostgreSQL schema and authoritative lock",()=>{
  it("retains independent blocking findings when a missing stop prevents sizing",async()=>{
    const a=await account();await admin();
    const {rows}=await db.query<{value:unknown}>("select private.risk_report($1::jsonb,a,o,r,i,s.id,'2099-09-05T17:00:00Z'::timestamptz,2,100,false) value from public.accounts a join public.account_observations o on o.account_id=a.id join public.risk_plan_versions r on r.account_id=a.id join public.instrument_versions i on i.account_id=a.id join public.strategy_versions s on s.account_id=a.id where a.id=$2 and i.id=$3",[JSON.stringify(proposal(a,{stop:null})),a.id,a.instrumentId]);
    const report=riskReportSchema.parse(rows[0].value);expect(report.decision).toBe('BLOCKED');expect(report.sessionEligible).toBe(false);
    expect(report.issues.map(i=>i.code)).toEqual(expect.arrayContaining(['MISSING_STOP','DEAD_POOL','MAX_TRADES','STALE_EQUITY']));
    expect(report.ruleResults.find(r=>r.rule==='SIZING_INVARIANT')?.outcome).toBe('NOT_EVALUATED');
  });
  it("installs fixed UTC−5 date/session functions",async()=>{
    for (const time of ["2026-03-08T07:00:00Z","2026-03-08T17:00:00Z","2026-11-01T23:00:00Z","2026-09-04T04:59:59Z",...['05:59','06:00','06:59','07:00','16:59','17:00','22:59','23:00'].map(t=>`2026-09-05T${t}:00Z`)]) {
      const {rows}=await db.query<{trading_day:string;session:string}>("select private.strategy_day($1)::text as trading_day,private.strategy_session($1) as session",[time]);
      const c=strategyClock(time);expect(rows[0]).toEqual({trading_day:c.day,session:c.session});
    }
    // The isolated single-connection test harness fixes only session classification for lock scenarios.
    // Production RPCs retain clock_timestamp(); session boundaries are tested above and through parity below.
    await db.exec("create or replace function private.strategy_session(p_now timestamptz) returns text language sql immutable set search_path='' as $$ select 'ACTIVE_KILL_ZONE'::text $$;");
  });
  it("atomically creates baseline strategy, risk version and observation",async()=>{
    const a=await account();
    const {rows}=await db.query<{version:string;rules:{execution_models:string[]}}>("select version,rules from public.strategy_versions where id=$1",[a.strategyId]);
    expect(rows[0].version).toBe("ICT V1.0");expect(rows[0].rules.execution_models).toEqual(["OB_FIRST_TOUCH","OTE"]);
  });
  it("locks exact versions and appends the original event once across replay",async()=>{
    const a=await account(),key=randomUUID();const first=await lock(a,proposal(a),key);const second=await lock(a,proposal(a),key);
    expect(first.planId).toBeTruthy();expect(second.planId).toBe(first.planId);expect(second.replayed).toBe(true);
    const {rows}=await db.query<{strategy_version_id:string;risk_plan_version_id:string;account_observation_id:string}>("select strategy_version_id,risk_plan_version_id,account_observation_id from public.trade_plans where id=$1",[first.planId]);
    expect(rows[0]).toEqual({strategy_version_id:a.strategyId,risk_plan_version_id:a.riskId,account_observation_id:a.observationId});
    expect((await db.query<{n:number}>("select count(*)::int n from public.trade_events where plan_id=$1",[first.planId])).rows[0].n).toBe(1);
    await expect(lock(a,proposal(a,{narrative:"Changed hindsight"}),key)).rejects.toThrow(/Idempotency/);
  });
  it("blocks duplicates and a third daily reservation",async()=>{
    const a=await account();expect((await lock(a)).planId).toBeTruthy();
    expect((await lock(a)).result.issues.map(i=>i.code)).toContain("DUPLICATE");
    expect((await lock(a,proposal(a,{entry:"1.2",stop:"1.198",target:"1.206"}))).planId).toBeTruthy();
    const r=await lock(a,proposal(a,{entry:"1.3",stop:"1.298",target:"1.306"}));
    expect(r.planId).toBeNull();expect(r.result.issues.map(i=>i.code)).toContain("MAX_TRADES");
  });
  it.each(["model","direction","news"])("rejects null %s via direct RPC",async key=>{
    const a=await account();const result=await lock(a,proposal(a,{[key]:null}));
    expect(result.planId).toBeNull();expect(result.result.status).toBe("TRADE_BLOCKED");
  });
  it("persists blocked risk evaluations without a plan or reservation",async()=>{
    const a=await account();const r=await lock(a,proposal(a,{stop:null}));expect(r.planId).toBeNull();
    expect((await db.query<{n:number}>("select count(*)::int n from public.risk_evaluations where account_id=$1",[a.id])).rows[0].n).toBe(1);
    expect((await db.query<{n:number}>("select count(*)::int n from public.trade_plans where account_id=$1",[a.id])).rows[0].n).toBe(0);
  });
  it("denies cross-tenant reads, notes and account access",async()=>{
    const a=await account();const p=await lock(a);await actor(other);
    expect((await db.query("select * from public.trade_plans where id=$1",[p.planId])).rows).toHaveLength(0);
    await expect(lock(a)).rejects.toThrow(/Account not found/);
    await expect(db.query("select public.append_plan_note($1,'Cross tenant')",[p.planId])).rejects.toThrow(/not found/);
  });
  it("denies direct writes, anonymous RPCs and mutations even by table owner",async()=>{
    const a=await account();const p=await lock(a);
    await expect(db.query("update public.trade_plans set proposal='{}' where id=$1",[p.planId])).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.trade_plans where id=$1",[p.planId])).rejects.toThrow(/permission denied/);
    await admin();await expect(db.query("update public.trade_plans set proposal='{}' where id=$1",[p.planId])).rejects.toThrow(/Immutable/);
    await expect(db.query("update public.strategy_versions set version='Changed' where id=$1",[a.strategyId])).rejects.toThrow(/Immutable/);
    await actor("","anon");await expect(db.query("select public.create_demo_account('X','10000','10000')")).rejects.toThrow(/permission denied/);
  });
  it("preserves original plan when a note is appended and rejects null notes",async()=>{
    const a=await account();const p=await lock(a);await db.query("select public.append_plan_note($1,'A later observation')",[p.planId]);
    const {rows}=await db.query<{event_type:string}>("select event_type from public.trade_events where plan_id=$1 order by sequence",[p.planId]);expect(rows.map(e=>e.event_type)).toEqual(["PLAN_LOCKED","NOTE_ADDED"]);
    await expect(db.query("select public.append_plan_note($1,null)",[p.planId])).rejects.toThrow(/Note must/);
    expect((await db.query<{proposal:{narrative:string}}>("select proposal from public.trade_plans where id=$1",[p.planId])).rows[0].proposal.narrative).toBe("Original pretrade belief");
  });
  it("schedules next-day risk versions and protects historical links on immediate change",async()=>{
    const a=await account();const p=await lock(a);
    const conf={maxRiskPercent:"0.25",maxDailyTrades:2,minRR:"3",rrPolicy:"BLOCK",newsPolicy:"WARN",dailyRiskCap:null,dailyLossCap:null};
    const {rows}=await db.query<{id:string}>("select public.create_risk_version($1,$2::jsonb) id",[a.id,JSON.stringify(conf)]);
    await admin();
    const day=(await db.query<{next:boolean}>("select effective_day=private.strategy_day(clock_timestamp())+1 as next from public.risk_plan_versions where id=$1",[rows[0].id])).rows[0];expect(day.next).toBe(true);
    await actor(owner);
    await expect(db.query("select public.create_risk_version($1,$2::jsonb,true,null)",[a.id,JSON.stringify(conf)])).rejects.toThrow(/reason/);
    await db.query("select public.create_risk_version($1,$2::jsonb,true,'Deliberate test override')",[a.id,JSON.stringify(conf)]);
    await expect(lock(a,proposal(a,{target:"1.108"}))).rejects.toThrow(/changed/);
    expect((await db.query<{id:string}>("select risk_plan_version_id id from public.trade_plans where id=$1",[p.planId])).rows[0].id).toBe(a.riskId);
  });
  it("rejects stale form observations and fractional cents",async()=>{
    const a=await account();
    await expect(db.query("select public.record_observation($1,'10000.99999','10000',null)",[a.id])).rejects.toThrow(/two decimal/);
    await db.query("select public.record_observation($1,'9990','9990',null)",[a.id]);
    await expect(lock(a)).rejects.toThrow(/changed/);
  });
  it("rolls back plan creation if its audit event cannot be written",async()=>{
    const a=await account();await admin();
    await db.exec("create function private.test_reject_event() returns trigger language plpgsql as $$ begin raise exception 'test audit failure'; end $$; create trigger test_audit_failure before insert on public.trade_events for each row execute function private.test_reject_event();");
    await actor(owner);await expect(lock(a)).rejects.toThrow(/test audit failure/);
    expect((await db.query<{n:number}>("select count(*)::int n from public.trade_plans where account_id=$1",[a.id])).rows[0].n).toBe(0);
    await admin();await db.exec("drop trigger test_audit_failure on public.trade_events; drop function private.test_reject_event();");
  });
  it("matches TypeScript exact calculations and findings for shared cases",async()=>{
    const a=await account();await admin();
    for (const changes of [{},{target:"1.10599"},{riskPercent:"0.51"},{model:"OTE"},{stop:null},{direction:"SHORT",stop:"1.102",target:"1.094"},{contradiction:true},{entry:"1.100001"},{news:"RESTRICTED"}]) {
      const p=proposal(a,changes);
      const {rows}=await db.query<{value:RiskResult}>("select private.evaluate_risk($1::jsonb,a,o,r,i,s.id,$2::timestamptz,0,0,false) value from public.accounts a join public.account_observations o on o.account_id=a.id join public.risk_plan_versions r on r.account_id=a.id join public.instrument_versions i on i.account_id=a.id join public.strategy_versions s on s.account_id=a.id where a.id=$3 and i.id=$4",[JSON.stringify(p),new Date().toISOString(),a.id,a.instrumentId]);
      const ts=evaluateRisk(p,{...previewContext,now:strategyClock(new Date()).day+"T14:00:00Z",observationDay:strategyClock(new Date()).day,instrument:{...previewContext.instrument,id:a.instrumentId},strategyVersionId:a.strategyId,plan:{...previewContext.plan,id:a.riskId}});
      const sql=rows[0].value;
      expect(sql.status).toBe(ts.status);expect(sql.issues.map(i=>i.code).sort()).toEqual(ts.issues.map(i=>i.code).sort());
      if(sql.calculations && ts.calculations) for(const key of ["budget","permittedRisk","stopDistance","stopTicks","plannedRR","quantity","nominalRisk","plannedReward"] as const) expect(new Decimal(sql.calculations[key]).eq(ts.calculations[key])).toBe(true);
    }
  });
  it("uses exact SQL quotient at the rounding regression boundary",async()=>{
    await admin();
    const {rows}=await db.query<{qty:string;within:boolean}>("select (div(4999999999.99,0.33333333*0.00000001)*0.00000001)::text qty, div(4999999999.99,0.33333333*0.00000001)*0.00000001*0.33333333<=4999999999.99 as within");
    expect(rows[0].qty).toBe("15000000149.97000149");expect(rows[0].within).toBe(true);
  });
  it("retries bootstrap atomically without duplicate versions and rejects conflicting reuse",async()=>{
    await actor(owner);const key=randomUUID();
    const create=()=>db.query<{id:string}>("select public.bootstrap_demo_account($1,'Retry','10000','10000') id",[key]);
    const a=(await create()).rows[0].id;expect((await create()).rows[0].id).toBe(a);
    for(const table of ['strategy_versions','risk_plan_versions','account_observations']) expect((await db.query<{n:number}>(`select count(*)::int n from public.${table} where account_id=$1`,[a])).rows[0].n).toBe(1);
    await expect(db.query("select public.bootstrap_demo_account($1,'Changed','10000','10000')",[key])).rejects.toThrow(/different input/);
    await expect(db.query("select public.create_demo_account('Old bypass','10000','10000')")).rejects.toThrow(/permission denied/);
  });
  it("saves explicit approved and blocked checks without reserving slots",async()=>{
    const a=await account();
    for(const p of [proposal(a),proposal(a,{stop:null}),proposal(a,{entry:'oops'})]) {
      const {rows}=await db.query<{value:unknown}>("select public.evaluate_trade_plan($1,$2::jsonb,$3,$4) value",[a.id,JSON.stringify(p),a.riskId,a.observationId]);
      const e=evaluationEnvelopeSchema.parse(rows[0].value);expect(e.planId).toBeNull();expect(e.evaluationId).toBeTruthy();
      const report=riskReportSchema.parse(e.result);expect(report.snapshot.slotsUsed).toBe(0);
      expect(report.decision).toBe(p.stop && p.entry !== 'oops' ? 'APPROVED':'BLOCKED');
      if(p.stop===null) expect(report.ruleResults.find(r=>r.rule==='MIN_RR')?.outcome).toBe('NOT_EVALUATED');
    }
    expect((await db.query<{n:number}>("select count(*)::int n from public.risk_evaluations where account_id=$1 and source='EXPLICIT_CHECK'",[a.id])).rows[0].n).toBe(3);
    expect((await db.query("select id from public.trade_plans where account_id=$1",[a.id])).rows).toHaveLength(0);
  });
  it("preserves exact lock replay and canonical duplicate detection",async()=>{
    const a=await account(),key=randomUUID();const first=await lock(a,proposal(a),key);await lock(a,proposal(a),key);
    expect((await db.query("select id from public.risk_evaluations where account_id=$1",[a.id])).rows).toHaveLength(1);
    await expect(db.query("select public.lock_trade_plan($1,null,$2,$3,$4)",[a.id,key,a.riskId,a.observationId])).rejects.toThrow(/Idempotency/);
    expect((await lock(a,proposal(a,{instrumentId:a.instrumentId.toUpperCase()}))).result.issues.map(i=>i.code)).toContain('DUPLICATE');
    expect(first.planId).toBeTruthy();
  });
  it("enforces owner-only read policy and write denial on every tenant table",async()=>{
    const a=await account();await lock(a);await admin();
    const {rows}=await db.query<{tablename:string;rowsecurity:boolean}>("select tablename,rowsecurity from pg_tables where schemaname='public'");
    expect(rows).toHaveLength(17);
    for(const table of rows){
      expect(table.rowsecurity).toBe(true);
      const policies=await db.query<{cmd:string;qual:string}>("select cmd,qual from pg_policies where schemaname='public' and tablename=$1",[table.tablename]);
      expect(policies.rows).toHaveLength(1);expect(policies.rows[0].cmd).toBe('SELECT');expect(policies.rows[0].qual).toContain('auth.uid()');
      await actor(other);expect((await db.query(`select * from public.${table.tablename} where user_id=$1`,[owner])).rows).toHaveLength(0);
      await expect(db.query(`delete from public.${table.tablename} where user_id=$1`,[owner])).rejects.toThrow(/permission denied/);await admin();
    }
    await actor(other);await expect(db.query("select public.evaluate_trade_plan($1,$2::jsonb,$3,$4)",[a.id,JSON.stringify(proposal(a)),a.riskId,a.observationId])).rejects.toThrow(/Account not found/);
  });
});
