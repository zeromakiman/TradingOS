import {beforeEach,describe,it,expect,vi} from "vitest";
import {ids,sources,week} from "./fixtures/weekly-review";
const m=vi.hoisted(()=>({auth:vi.fn(),rows:{} as Record<string,Record<string,unknown>[]>,queries:[] as {table:string;filters:[string,string,unknown][];limit?:number}[],errors:new Set<string>()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/supabase/server",()=>({requireUser:m.auth}));
import {ownedWeeklyAccount,loadWeeklyFacts} from "@/lib/weekly-review-source";
beforeEach(()=>{
 m.queries=[];m.errors.clear();const s=structuredClone(sources[0]);
 m.rows={accounts:[{id:ids.account,name:"Synthetic",user_id:ids.user}],journal_analytics:[s.trade],trade_plans:[{...s.plan,user_id:ids.user}],strategy_versions:[{...s.strategy,account_id:ids.account,user_id:ids.user}],risk_plan_versions:[{...s.risk,account_id:ids.account,user_id:ids.user}],trade_events:s.events.map(e=>({...e,plan_id:ids.plan,account_id:ids.account,user_id:ids.user}))};
 const db={from:(table:string)=>{
  const q={table,filters:[] as [string,string,unknown][],limit:undefined as number|undefined};m.queries.push(q);let single=false;
  const result=()=>{let rows=(m.rows[table]??[]).filter(r=>q.filters.every(([kind,k,v])=>kind==="eq"?r[k]===v:kind==="in"?(v as unknown[]).includes(r[k]):kind==="gte"?String(r[k])>=String(v):String(r[k])<String(v)));if(q.limit)rows=rows.slice(0,q.limit);return {data:single?(rows[0]??null):rows,error:m.errors.has(table)?{}:null};};
  // biome-ignore lint/suspicious/noThenProperty: Supabase query double.
  const chain={select:()=>chain,eq:(k:string,v:unknown)=>{q.filters.push(["eq",k,v]);return chain;},in:(k:string,v:unknown)=>{q.filters.push(["in",k,v]);return chain;},gte:(k:string,v:unknown)=>{q.filters.push(["gte",k,v]);return chain;},lt:(k:string,v:unknown)=>{q.filters.push(["lt",k,v]);return chain;},order:()=>chain,limit:(n:number)=>{q.limit=n;return chain;},maybeSingle:()=>{single=true;return chain;},then:(resolve:(v:unknown)=>void)=>resolve(result())};
  return chain;
 }};m.auth.mockResolvedValue({db,user:{id:ids.user}});
});
const load=async()=>loadWeeklyFacts(await ownedWeeklyAccount(ids.account),week);
describe("weekly owner-scoped bounded database selection",()=>{
 it("uses authenticated owner with no fallback to another account",async()=>{await expect(ownedWeeklyAccount(ids.image)).rejects.toThrow(/unavailable/);m.rows.accounts[0].user_id=ids.image;await expect(ownedWeeklyAccount(ids.account)).rejects.toThrow(/unavailable/);});
 it("signed-out access cannot read source data",async()=>{m.auth.mockRejectedValueOnce(new Error("signed out"));await expect(load()).rejects.toThrow();expect(m.queries).toEqual([]);});
 it("excludes foreign, prior-week, next-week and open trades in database selection",async()=>{const t=m.rows.journal_analytics[0];m.rows.journal_analytics.push({...t,id:ids.image,account_id:ids.image},{...t,id:ids.event,exited_at:"2026-08-31T04:59:59Z"},{...t,id:ids.review,exited_at:"2026-09-07T05:00:00Z"},{...t,id:ids.user,status:"TAKEN"});const result=await load();expect(result.trades.map(t=>t.tradeId)).toEqual([ids.plan]);expect(m.queries.find(q=>q.table==="journal_analytics")).toMatchObject({limit:41,filters:[["eq","account_id",ids.account],["eq","status","CLOSED"],["gte","exited_at","2026-08-31T05:00:00.000Z"],["lt","exited_at","2026-09-07T05:00:00.000Z"]]});});
 it("queries only original versions and selected plans; no unrelated tables",async()=>{await load();expect(m.queries.map(q=>q.table)).toEqual(["accounts","journal_analytics","trade_plans","strategy_versions","risk_plan_versions","trade_events"]);for(const q of m.queries.slice(2)){expect(q.filters).toContainEqual(["eq","account_id",ids.account]);expect(q.filters).toContainEqual(["eq","user_id",ids.user]);}expect(m.queries.find(q=>q.table==="trade_plans")?.filters).toContainEqual(["in","id",[ids.plan]]);});
 it("excludes events from unrelated trades, out-of-week times and later backfilled notes",async()=>{const e=m.rows.trade_events[0];m.rows.trade_events.push({...e,id:ids.image,plan_id:ids.image},{...e,id:ids.event,occurred_at:"2026-09-07T05:00:00Z"},{...e,id:ids.review,recorded_at:"2026-09-10T05:00:00Z"});const facts=await load();expect(facts.trades[0].events).toHaveLength(1);expect(JSON.stringify(facts)).not.toContain("plan_id");});
 it("empty week reads no version/event history",async()=>{m.rows.journal_analytics=[];expect((await load()).trades).toEqual([]);expect(m.queries).toHaveLength(2);});
 it("fails closed on unavailable source records",async()=>{m.errors.add("trade_events");await expect(load()).rejects.toThrow(/unavailable/);});
 it("missing original versions cannot silently drop a trade",async()=>{m.rows.strategy_versions=[];await expect(load()).rejects.toThrow(/Original/);});
 it("future/current week is rejected before querying trades",async()=>{await expect(loadWeeklyFacts(await ownedWeeklyAccount(ids.account),"2099-12-21")).rejects.toThrow(/completed/);expect(m.queries).toHaveLength(1);});
 it("over 40 trades fails before context enrichment",async()=>{m.rows.journal_analytics=Array(41).fill(m.rows.journal_analytics[0]);await expect(load()).rejects.toThrow(/40-trade/);expect(m.queries).toHaveLength(2);});
 it("over 200 events is not silently truncated",async()=>{m.rows.trade_events=Array(201).fill(m.rows.trade_events[0]);await expect(load()).rejects.toThrow(/200-event/);});
 it("oversized text blocks with no partial context",async()=>{m.rows.strategy_versions[0].written_rules="a".repeat(96001);await expect(load()).rejects.toThrow(/text size/);});
});
