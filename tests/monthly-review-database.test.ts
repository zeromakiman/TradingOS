import {monthlyOutput} from './fixtures/monthly-review';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {plan as fixture} from './fixtures/trade-review';
let db:PGlite;
const owner='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',hash='a'.repeat(64);
async function actor(id=owner,role='authenticated'){await db.exec(`reset role;set role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;insert into auth.users values('${owner}'),('${other}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
 for(const f of readdirSync('supabase/migrations').filter(x=>x.endsWith('.sql')).sort())await db.exec(readFileSync(`supabase/migrations/${f}`,'utf8'));
},30000);
afterAll(async()=>{await db.close();});
async function seed(closed=true){
 await actor();const a=(await db.query<{id:string}>("select public.bootstrap_demo_account($1,'Synthetic review account','10000','10000') id",[randomUUID()])).rows[0].id;
 const ids=(await db.query<{i:string;r:string;o:string;s:string}>("select (select id from public.instrument_versions where account_id=$1 and symbol='EURUSD') i,(select id from public.risk_plan_versions where account_id=$1) r,(select id from public.account_observations where account_id=$1 limit 1) o,(select id from public.strategy_versions where account_id=$1) s",[a])).rows[0];
 const p=randomUUID(),e=randomUUID(),proposal=JSON.stringify({...fixture.proposal,instrumentId:ids.i}),report=JSON.stringify(fixture.risk_result);
 await db.exec('reset role');
 await db.query('insert into public.risk_evaluations(id,user_id,account_id,proposal,result) values($1,$2,$3,$4,$5)',[e,owner,a,proposal,report]);
 await db.query("insert into public.trade_plans(id,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,50,'2026-07-01','2026-07-01T07:00Z')",[p,owner,a,ids.s,ids.r,ids.i,ids.o,e,randomUUID(),proposal,report]);
 await actor();if(closed){await db.query("select public.open_journal_trade($1,'1.1','0.25','2026-07-01T08:00Z')",[p]);await db.query("select public.close_journal_trade($1,'1.106','2026-08-15T09:00Z','0')",[p]);}
 await db.query('select public.set_account_ai_preferences($1,true,500,true)',[a]);return {a,p};
}



async function snapshot(a:string,month='2026-08-01'){
 await actor();const p=new Date(month+'T05:00:00Z'),end=new Date(Date.UTC(p.getUTCFullYear(),p.getUTCMonth()+1,1,5));
 const ids=(await db.query<{id:string}>('select plan_id id from public.trade_outcomes where account_id=$1 and exited_at >= $2 and exited_at < $3 order by exited_at,plan_id',[a,p.toISOString(),end.toISOString()])).rows.map(x=>x.id);
 return {version:'MONTHLY_REVIEW_FACTS_V1',period:{startDate:month,start:p.toISOString(),endExclusive:end.toISOString()},sample:{count:ids.length,tradeIds:ids},trades:ids.map(tradeId=>({tradeId}))};
}
async function start(a:string,id=randomUUID(),user=owner,month='2026-08-01',facts?:unknown){
 const data=facts??await snapshot(a,month);await actor(owner,'service_role');
 return {id,result:await db.query<{ok:boolean}>("select public.start_monthly_ai_review($1,$2,$3,$4,$5,$6,'{\"id\":\"MONTHLY_REVIEW\"}','{}') ok",[id,user,a,month,JSON.stringify(data),hash])};
}
async function finish(id:string,reservation:string|null=null,status='FAILED',user=owner){
 await actor(owner,'service_role');return db.query('select public.finish_monthly_ai_review($1,$2,$3,$4,$5,$6,$7)',[id,user,status,status==='COMPLETED'?JSON.stringify(monthlyOutput):null,status==='FAILED'?'MOCK_FAILURE':null,null,reservation]);
}
async function reserve(a:string,review:string,operation='MONTHLY_REVIEW',settled=true){
 await actor(owner,'service_role');const id=randomUUID();await db.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-6-astra','{}',924000,$6,'openai')",[id,owner,a,review,hash,operation]);
 if(settled){await db.query('select public.dispatch_account_ai_request($1,$2,$3)',[id,owner,hash]);await db.query("select public.settle_account_ai_request($1,$2,'{\"disposition\":\"SETTLED\",\"chargedMicros\":21000,\"inputTokens\":1000,\"outputTokens\":100,\"usage\":{\"input_tokens\":1000,\"output_tokens\":100}}')",[id,owner]);}return id;
}
async function addTrade(a:string,close:string,closed=true){
 const id=randomUUID();await db.exec('reset role');
 await db.query("insert into public.trade_plans(id,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at) select $1,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,$2,proposal,risk_result,nominal_risk,trading_day,locked_at from public.trade_plans where account_id=$3 limit 1",[id,randomUUID(),a]);
 await actor();await db.query("select public.open_journal_trade($1,'1.1','0.25','2026-07-01T08:00Z')",[id]);
 if(closed)await db.query("select public.close_journal_trade($1,'1.106',$2,'0')",[id,close]);return id;
}
describe('monthly database scope, RLS and immutable accounting',()=>{
 it('owner required even for service RPC',async()=>{const {a}=await seed();await expect(start(a,randomUUID(),other)).rejects.toThrow(/not found/);});
 it.each(['2026-08-02','2099-12-01','1999-12-01'])('rejects noncompleted/invalid month %s',async m=>{const {a}=await seed();await expect(start(a,randomUUID(),owner,m,{})).rejects.toThrow(/completed/);});
 it('open/empty month cannot dispatch',async()=>{const {a}=await seed(false);await expect(start(a)).rejects.toThrow(/empty/);});
 it('exact UTC-5 interval, microsecond end, stable ties, no open or neighboring-month trades',async()=>{
  const {a,p}=await seed();const first=await addTrade(a,'2026-08-01T05:00:00Z'),last=await addTrade(a,'2026-09-01T04:59:59.999999Z'),tie=await addTrade(a,'2026-09-01T04:59:59.999999Z');
  await addTrade(a,'2026-08-01T04:59:59.999999Z');await addTrade(a,'2026-09-01T05:00Z');await addTrade(a,'2026-08-20T12:00Z',false);
  const {id}=await start(a);await actor();const r=(await db.query<{trade_ids:string[];sample_size:number;start:string;end:string}>("select trade_ids,sample_size,to_char(period_start at time zone 'UTC','YYYY-MM-DD HH24:MI') start,to_char(period_end_exclusive at time zone 'UTC','YYYY-MM-DD HH24:MI') end from public.monthly_ai_reviews where id=$1",[id])).rows[0];
  expect(r).toEqual({trade_ids:[first,p,...[last,tie].sort()],sample_size:4,start:'2026-08-01 05:00',end:'2026-09-01 05:00'});
 });
 it('foreign, missing or reordered trade IDs and forged boundaries are refused',async()=>{const {a}=await seed();await addTrade(a,'2026-08-20T10:00Z');const correct=await snapshot(a);for(const change of ['foreign','missing','order','bounds']){const f=structuredClone(correct);if(change==='foreign')f.sample.tradeIds[0]=randomUUID();if(change==='missing')f.trades.pop();if(change==='order')f.sample.tradeIds.reverse();if(change==='bounds')f.period.endExclusive='2026-09-01T00:00:00Z';await expect(start(a,randomUUID(),owner,'2026-08-01',f)).rejects.toThrow(/scope/);}});
 it('stale monthly snapshot after backfilled close fails closed',async()=>{const {a}=await seed(),f=await snapshot(a);await addTrade(a,'2026-08-23T10:00Z');await expect(start(a,randomUUID(),owner,'2026-08-01',f)).rejects.toThrow(/scope/);});
 it('owner-only read; cross-user and signed-out history denied',async()=>{const {a}=await seed(),{id}=await start(a);await finish(id);await actor();expect((await db.query('select * from public.monthly_ai_reviews where id=$1',[id])).rows).toHaveLength(1);await actor(other);for(const t of ['monthly_ai_reviews','monthly_ai_review_results'])expect((await db.query('select * from public.'+t)).rows).toHaveLength(0);await actor(owner,'anon');await expect(db.query('select * from public.monthly_ai_reviews')).rejects.toThrow(/permission/);});
 it('browser/service direct writes denied and browser cannot invoke privileged RPCs',async()=>{for(const role of ['anon','authenticated','service_role']){await actor(owner,role);for(const t of ['monthly_ai_reviews','monthly_ai_review_results'])await expect(db.query('insert into public.'+t+' default values')).rejects.toThrow(/permission/);}for(const role of ['anon','authenticated']){await actor(owner,role);await expect(db.query("select public.start_monthly_ai_review($1,$2,$3,'2026-08-01','{}',$4,'{}','{}')",[randomUUID(),owner,randomUUID(),hash])).rejects.toThrow(/permission/);await expect(db.query('select public.authorize_monthly_ai_review($1,$2)',[randomUUID(),owner])).rejects.toThrow(/permission/);await expect(db.query("select public.finish_monthly_ai_review($1,$2,'FAILED',null,'err',null,null)",[randomUUID(),owner])).rejects.toThrow(/permission/);}});
 it('idempotent replay and in-flight protection',async()=>{const {a}=await seed(),{id}=await start(a);expect((await start(a,id)).result.rows[0].ok).toBe(false);await expect(start(a)).rejects.toThrow(/running/);await expect(start(a,id,owner,'2026-07-01')).rejects.toThrow(/not found/);await finish(id);expect((await start(a,id)).result.rows[0].ok).toBe(false);});
 it('authorize rejects foreign or terminal request',async()=>{const {a}=await seed(),{id}=await start(a);await expect(db.query('select public.authorize_monthly_ai_review($1,$2)',[id,other])).rejects.toThrow(/unavailable/);await db.query('select public.authorize_monthly_ai_review($1,$2)',[id,owner]);await finish(id);await expect(db.query('select public.authorize_monthly_ai_review($1,$2)',[id,owner])).rejects.toThrow(/unavailable/);});
 it('exact request and operation reservation required before completed result',async()=>{const {a}=await seed(),{id}=await start(a);await expect(finish(id,null,'COMPLETED')).rejects.toThrow(/reconciled/);await expect(finish(id,await reserve(a,randomUUID()),'COMPLETED')).rejects.toThrow(/mismatch/);await expect(finish(id,await reserve(a,id,'WEEKLY_REVIEW'),'COMPLETED')).rejects.toThrow(/mismatch/);});
 it('settlement releases unused reservation; uncertain cost stays held',async()=>{const {a}=await seed(),first=await start(a);await finish(first.id,await reserve(a,first.id),'COMPLETED');await actor();expect((await db.query<{value:Record<string,unknown>}>('select public.get_account_ai_budget($1) value',[a])).rows[0].value).toMatchObject({usedMicros:21000,heldMicros:0});const second=await start(a),hold=await reserve(a,second.id,'MONTHLY_REVIEW',false);await expect(finish(second.id,hold,'COMPLETED')).rejects.toThrow(/reconciled/);await finish(second.id,hold);await actor();expect((await db.query<{value:Record<string,unknown>}>('select public.get_account_ai_budget($1) value',[a])).rows[0].value).toMatchObject({heldMicros:924000});});
 it('reruns append, preserve exact IDs and core data, survive opt-out, cannot mutate history',async()=>{const {a,p}=await seed();await actor();const capture=async()=>Promise.all(['trade_plans','trade_outcomes','trade_events','journal_analytics'].map(t=>db.query('select row_to_json(t) value from public.'+t+' t where '+(t==='trade_plans'||t==='journal_analytics'?'id':'plan_id')+'=$1',[p]).then(x=>x.rows)));const before=await capture(),first=await start(a);await finish(first.id,await reserve(a,first.id),'COMPLETED');const second=await start(a);await finish(second.id);await expect(finish(second.id)).rejects.toThrow(/duplicate/);await actor();expect(await capture()).toEqual(before);await db.query('select public.set_account_ai_preferences($1,false,null,false)',[a]);const rows=(await db.query<{trade_ids:string[]}>('select trade_ids from public.monthly_ai_reviews where account_id=$1',[a])).rows;expect(rows).toEqual([{trade_ids:[p]},{trade_ids:[p]}]);await db.exec('reset role');for(const t of ['monthly_ai_reviews','monthly_ai_review_results']){await expect(db.query('delete from public.'+t)).rejects.toThrow(/immutable/i);await expect(db.query('update public.'+t+' set user_id=user_id')).rejects.toThrow(/immutable/i);}});
 it.each([300,500,1000])('queued reservations respect %s-cent budget',async cents=>{const {a}=await seed();await actor();await db.query('select public.set_account_ai_preferences($1,true,$2,true)',[a,cents]);await actor(owner,'service_role');const results=await Promise.allSettled(Array.from({length:20},()=>db.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-6-astra','{}',924000,'MONTHLY_REVIEW','openai')",[randomUUID(),owner,a,randomUUID(),hash])));expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(Math.floor(cents*10000/924000));});
});
