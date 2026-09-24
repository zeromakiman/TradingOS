import {recentOutput} from './fixtures/recent-trades';
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
 await db.query("insert into public.trade_plans(id,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,50,'2026-09-01','2026-09-01T07:00Z')",[p,owner,a,ids.s,ids.r,ids.i,ids.o,e,randomUUID(),proposal,report]);
 await actor();if(closed){await db.query("select public.open_journal_trade($1,'1.1','0.25','2026-09-01T08:00Z')",[p]);await db.query("select public.close_journal_trade($1,'1.106','2026-09-01T09:00Z','0')",[p]);}
 await db.query('select public.set_account_ai_preferences($1,true,500,true)',[a]);return {a,p};
}


async function sampleIds(a:string,n=20){await actor();const ids=(await db.query<{id:string}>("select plan_id id from public.trade_outcomes where account_id=$1 order by exited_at desc,plan_id asc limit $2",[a,n])).rows.map(x=>x.id);await actor(owner,'service_role');return ids;}
async function start(a:string,id=randomUUID(),user=owner,n=20,override?:string[]){
 await actor(owner,'service_role');const ids=override??await sampleIds(a,n),captured=new Date().toISOString();
 const facts={version:"RECENT_TRADES_FACTS_V1",capturedAt:captured,sample:{requested:n,actual:ids.length,tradeIds:ids},trades:ids.map(tradeId=>({tradeId}))};
 return {id,result:await db.query<{ok:boolean}>("select public.start_recent_ai_analysis($1,$2,$3,$4,$5,$6,$7,$8,'{\"id\":\"RECENT_TRADES_ANALYSIS\"}','{}') ok",[id,user,a,n,ids,captured,JSON.stringify(facts),hash])};
}
async function finish(id:string,reservation:string|null=null,status='FAILED',user=owner){
 await actor(owner,'service_role');return db.query('select public.finish_recent_ai_analysis($1,$2,$3,$4,$5,$6,$7)',[id,user,status,status==='COMPLETED'?JSON.stringify(recentOutput):null,status==='FAILED'?'MOCK_FAILURE':null,null,reservation]);
}
async function reserve(a:string,analysis:string,operation='RECENT_TRADES_ANALYSIS',settled=true){
 await actor(owner,'service_role');const id=randomUUID();await db.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-6-astra','{}',924000,$6,'openai')",[id,owner,a,analysis,hash,operation]);
 if(settled){await db.query('select public.dispatch_account_ai_request($1,$2,$3)',[id,owner,hash]);await db.query("select public.settle_account_ai_request($1,$2,'{\"disposition\":\"SETTLED\",\"chargedMicros\":21000,\"inputTokens\":1000,\"outputTokens\":100,\"usage\":{\"input_tokens\":1000,\"output_tokens\":100}}')",[id,owner]);}return id;
}
async function addTrade(a:string,close:string,closed=true){
 const id=randomUUID();await db.exec('reset role');
 await db.query("insert into public.trade_plans(id,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at) select $1,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,$2,proposal,risk_result,nominal_risk,trading_day,locked_at from public.trade_plans where account_id=$3 limit 1",[id,randomUUID(),a]);
 await actor();await db.query("select public.open_journal_trade($1,'1.1','0.25','2026-09-01T08:00Z')",[id]);
 if(closed)await db.query("select public.close_journal_trade($1,'1.106',$2,'0')",[id,close]);return id;
}
describe('recent-trades PostgreSQL selection, RLS and immutable accounting history',()=>{
 it('requires owner account even for privileged start',async()=>{const {a}=await seed();await expect(start(a,randomUUID(),other)).rejects.toThrow(/not found/);});
 it('empty/open-only account cannot start',async()=>{const {a}=await seed(false);await expect(start(a)).rejects.toThrow(/completed/);});
 it.each([10,20,30])('SQL enforces exact latest %s trades and persists ordered IDs/actual count',async n=>{
  const {a}=await seed();for(let i=0;i<31;i++)await addTrade(a,new Date(Date.UTC(2026,8,2,9,i)).toISOString());await addTrade(a,'2026-09-02T11:00Z',false);
  await actor(owner,'service_role');const ids=await sampleIds(a,n);await expect(start(a,randomUUID(),owner,n,[...ids].reverse())).rejects.toThrow(/most recent/);
  const {id}=await start(a,randomUUID(),owner,n);await actor();const r=(await db.query<{requested_sample:number;actual_sample:number;trade_ids:string[]}>('select requested_sample,actual_sample,trade_ids from public.recent_ai_analyses where id=$1',[id])).rows[0];expect(r).toEqual({requested_sample:n,actual_sample:n,trade_ids:ids});
 });
 it('fewer completed records retain actual count; ties use UUID and microseconds without rounding',async()=>{const {a,p}=await seed();const first=await addTrade(a,'2026-09-01T09:00:00.000001Z'),second=await addTrade(a,'2026-09-01T09:00:00.000002Z'),tie=await addTrade(a,'2026-09-01T09:00:00.000002Z');const {id}=await start(a);await actor();const r=(await db.query<{actual_sample:number;trade_ids:string[]}>('select actual_sample,trade_ids from public.recent_ai_analyses where id=$1',[id])).rows[0];expect(r.actual_sample).toBe(4);expect(r.trade_ids).toEqual([...([second,tie].sort()),first,p]);});
 it('foreign IDs and stale sample after a new close cannot start',async()=>{const {a,p}=await seed();const otherAccount=await seed();await expect(start(a,randomUUID(),owner,20,[otherAccount.p])).rejects.toThrow(/most recent/);await addTrade(a,'2026-09-02T09:00Z');await expect(start(a,randomUUID(),owner,20,[p])).rejects.toThrow(/most recent/);});
 it('invalid requested size is rejected by SQL',async()=>{const {a,p}=await seed();await expect(start(a,randomUUID(),owner,11,[p])).rejects.toThrow(/Invalid/);});
 it('facts and metadata must contain the exact ordered IDs',async()=>{const {a,p}=await seed();await actor(owner,'service_role');const captured=new Date().toISOString(),facts={version:'RECENT_TRADES_FACTS_V1',capturedAt:captured,sample:{requested:20,actual:1,tradeIds:[p]},trades:[{tradeId:randomUUID()}]};await expect(db.query("select public.start_recent_ai_analysis($1,$2,$3,20,$4,$5,$6,$7,'{\"id\":\"RECENT_TRADES_ANALYSIS\"}','{}')",[randomUUID(),owner,a,[p],captured,JSON.stringify(facts),hash])).rejects.toThrow(/facts mismatch/);});
 it('browser/service direct writes and browser privileged RPCs are denied',async()=>{
  for(const role of ['anon','authenticated','service_role']){await actor(owner,role);for(const table of ['recent_ai_analyses','recent_ai_analysis_results'])await expect(db.query('insert into public.'+table+' default values')).rejects.toThrow(/permission/);}
  for(const role of ['anon','authenticated']){await actor(owner,role);await expect(db.query("select public.start_recent_ai_analysis($1,$2,$3,20,$4,clock_timestamp(),'{}',$5,'{}','{}')",[randomUUID(),owner,randomUUID(),[],hash])).rejects.toThrow(/permission/);await expect(db.query('select public.authorize_recent_ai_analysis($1,$2)',[randomUUID(),owner])).rejects.toThrow(/permission/);await expect(db.query("select public.finish_recent_ai_analysis($1,$2,'FAILED',null,'err',null,null)",[randomUUID(),owner])).rejects.toThrow(/permission/);}
 });
 it('owner-only history reads; signed-out denied',async()=>{const {a}=await seed(),{id}=await start(a);await finish(id);await actor();expect((await db.query('select * from public.recent_ai_analyses where id=$1',[id])).rows).toHaveLength(1);await actor(other);for(const table of ['recent_ai_analyses','recent_ai_analysis_results'])expect((await db.query('select * from public.'+table)).rows).toHaveLength(0);await actor(owner,'anon');await expect(db.query('select * from public.recent_ai_analyses')).rejects.toThrow(/permission/);});
 it('replay never starts again, including after history result',async()=>{const {a}=await seed(),{id}=await start(a);expect((await start(a,id)).result.rows[0].ok).toBe(false);await expect(start(a,id,owner,10)).rejects.toThrow(/not found/);await finish(id);expect((await start(a,id)).result.rows[0].ok).toBe(false);});
 it('one running analysis per account prevents duplicate runs across sample sizes',async()=>{const {a}=await seed();await start(a);await expect(start(a,randomUUID(),owner,10)).rejects.toThrow(/running/);});
 it('authorization rejects foreign and terminal requests',async()=>{const {a}=await seed(),{id}=await start(a);await expect(db.query('select public.authorize_recent_ai_analysis($1,$2)',[id,other])).rejects.toThrow(/unavailable/);await db.query('select public.authorize_recent_ai_analysis($1,$2)',[id,owner]);await finish(id);await expect(db.query('select public.authorize_recent_ai_analysis($1,$2)',[id,owner])).rejects.toThrow(/unavailable/);});
 it('completion requires the exact reconciled operation reservation',async()=>{const {a}=await seed(),{id}=await start(a);await expect(finish(id,null,'COMPLETED')).rejects.toThrow(/reconciled/);await expect(finish(id,await reserve(a,randomUUID()),'COMPLETED')).rejects.toThrow(/mismatch/);await expect(finish(id,await reserve(a,id,'WEEKLY_REVIEW'),'COMPLETED')).rejects.toThrow(/mismatch/);});
 it('successful reconciliation releases unused hold',async()=>{const {a}=await seed(),{id}=await start(a);await finish(id,await reserve(a,id),'COMPLETED');await actor();expect((await db.query<{value:Record<string,unknown>}>('select public.get_account_ai_budget($1) value',[a])).rows[0].value).toMatchObject({usedMicros:21000,heldMicros:0});});
 it('failed/incomplete accounting retains protection',async()=>{const {a}=await seed(),{id}=await start(a),reservation=await reserve(a,id,'RECENT_TRADES_ANALYSIS',false);await expect(finish(id,reservation,'COMPLETED')).rejects.toThrow(/reconciled/);await finish(id,reservation);await actor();expect((await db.query<{value:Record<string,unknown>}>('select public.get_account_ai_budget($1) value',[a])).rows[0].value).toMatchObject({heldMicros:924000});});
 it('reruns append exact snapshots, preserve core rows and survive opt-out',async()=>{
  const {a,p}=await seed();await actor();const capture=async()=>Promise.all(['trade_plans','trade_outcomes','trade_events','journal_analytics'].map(table=>db.query('select row_to_json(t) value from public.'+table+' t where '+(table==='trade_plans'||table==='journal_analytics'?'id':'plan_id')+'=$1',[p]).then(x=>x.rows)));const before=await capture();
  const first=await start(a);await finish(first.id,await reserve(a,first.id),'COMPLETED');const second=await start(a);await finish(second.id);await expect(finish(second.id)).rejects.toThrow(/duplicate/);await actor();expect(await capture()).toEqual(before);await db.query('select public.set_account_ai_preferences($1,false,null,false)',[a]);expect((await db.query('select * from public.recent_ai_analyses where account_id=$1',[a])).rows).toHaveLength(2);
  await db.exec('reset role');for(const table of ['recent_ai_analyses','recent_ai_analysis_results']){await expect(db.query('delete from public.'+table)).rejects.toThrow(/immutable/i);await expect(db.query('update public.'+table+' set user_id=user_id')).rejects.toThrow(/immutable/i);}
 });
 it.each([300,500,1000])('20 queued reservations cannot exceed EUR%s cents',async cents=>{const {a}=await seed();await actor();await db.query('select public.set_account_ai_preferences($1,true,$2,true)',[a,cents]);await actor(owner,'service_role');const results=await Promise.allSettled(Array.from({length:20},()=>db.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-6-astra','{}',924000,'RECENT_TRADES_ANALYSIS','openai')",[randomUUID(),owner,a,randomUUID(),hash])));const admitted=Math.floor(cents*10000/924000);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(admitted);await actor();expect((await db.query<{value:Record<string,unknown>}>('select public.get_account_ai_budget($1) value',[a])).rows[0].value).toMatchObject({heldMicros:admitted*924000});});
});
