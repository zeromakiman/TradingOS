import {beforeEach,describe,it,expect,vi} from "vitest";
import {ids,makeSources,capturedAt} from "./fixtures/recent-trades";
const m=vi.hoisted(()=>({auth:vi.fn(),rows:{} as Record<string,Record<string,unknown>[]>,queries:[] as {table:string;filters:[string,string,unknown][];orders:[string,boolean][];limit?:number}[],errors:new Set<string>()}));
vi.mock("server-only",()=>({}));vi.mock("@/lib/supabase/server",()=>({requireUser:m.auth}));
import {ownedRecentAccount,loadRecentFacts} from "@/lib/recent-trades-source";
beforeEach(()=>{
 m.queries=[];m.errors.clear();const rows=makeSources(35);
 m.rows={accounts:[{id:ids.account,name:"Synthetic",user_id:ids.user}],journal_analytics:rows.map(s=>s.trade),trade_plans:rows.map(s=>({...s.plan,user_id:ids.user})),strategy_versions:[{...rows[0].strategy,account_id:ids.account,user_id:ids.user}],risk_plan_versions:[{...rows[0].risk,account_id:ids.account,user_id:ids.user}],trade_events:rows.flatMap(s=>s.events.map(e=>({...e,plan_id:s.trade.id,account_id:ids.account,user_id:ids.user})))};
 const db={from:(table:string)=>{
  const q={table,filters:[] as [string,string,unknown][],orders:[] as [string,boolean][],limit:undefined as number|undefined};m.queries.push(q);let single=false;
  const result=()=>{let rows=(m.rows[table]??[]).filter(r=>q.filters.every(([kind,k,v])=>kind==="eq"?r[k]===v:kind==="in"?(v as unknown[]).includes(r[k]):kind==="not"?r[k]!==v:String(r[k])<=String(v)));const count=rows.length;
   rows.sort((a,b)=>{for(const [key,asc] of q.orders){const c=String(a[key]).localeCompare(String(b[key]));if(c)return asc?c:-c;}return 0;});
   if(q.limit)rows=rows.slice(0,q.limit);return {data:single?(rows[0]??null):rows,error:m.errors.has(table)?{}:null,count};};
  // biome-ignore lint/suspicious/noThenProperty: Supabase query double.
  const chain={select:()=>chain,eq:(k:string,v:unknown)=>{q.filters.push(["eq",k,v]);return chain;},in:(k:string,v:unknown)=>{q.filters.push(["in",k,v]);return chain;},not:(k:string,_op:string,v:unknown)=>{q.filters.push(["not",k,v]);return chain;},lte:(k:string,v:unknown)=>{q.filters.push(["lte",k,v]);return chain;},order:(k:string,opts?:{ascending:boolean})=>{q.orders.push([k,opts?.ascending??true]);return chain;},limit:(n:number)=>{q.limit=n;return chain;},maybeSingle:()=>{single=true;return chain;},then:(resolve:(v:unknown)=>void)=>resolve(result())};return chain;
 }};m.auth.mockResolvedValue({db,user:{id:ids.user}});
});
const load=async(n:unknown=20)=>loadRecentFacts(await ownedRecentAccount(ids.account),n);
describe("latest completed owner-only selection",()=>{
 it.each([10,20,30])("selects exactly newest %s of 35 across weeks, in stable descending order",async n=>{const result=await load(n),expected=makeSources(35).reverse().slice(0,n).map(s=>s.trade.id);expect(result.eligibleCount).toBe(35);expect(result.facts.sample).toMatchObject({requested:n,actual:n,tradeIds:expected});expect(result.facts.trades.map(t=>t.tradeId)).toEqual(expected);expect(m.queries.find(q=>q.table==="journal_analytics")?.orders).toEqual([["exited_at",false],["id",true]]);});
 it("defaults to 20",async()=>expect((await load()).facts.sample.requested).toBe(20));
 it("fewer than requested uses every eligible trade and states the limit",async()=>{m.rows.journal_analytics=m.rows.journal_analytics.slice(0,7);const r=await load(20);expect(r.eligibleCount).toBe(7);expect(r.facts.sample).toMatchObject({actual:7,fewerThanRequested:true});expect(r.facts.sample.caveat).toContain("Fewer completed trades");});
 it("exact timestamp ties use UUID ascending, even if source insertion order differs",async()=>{m.rows.journal_analytics=m.rows.journal_analytics.slice(0,12).reverse().map(t=>({...t,exited_at:capturedAt}));expect((await load(10)).facts.sample.tradeIds).toEqual(makeSources(10).map(s=>s.trade.id));});
 it("excludes open, skipped, cancelled, foreign and future trades without leaking history",async()=>{for(const status of ["TAKEN","LOCKED","CANCELLED","SKIPPED"]){m.rows.journal_analytics.push({...m.rows.journal_analytics[0],id:ids.image,status});}m.rows.journal_analytics.push({...m.rows.journal_analytics[0],id:ids.image,account_id:ids.image,exited_at:capturedAt},{...m.rows.journal_analytics[0],id:ids.event,exited_at:"2099-01-01T00:00:00Z"});const r=await load(30);expect(r.eligibleCount).toBe(35);expect(r.facts.sample.tradeIds).not.toContain(ids.image);expect(r.facts.sample.tradeIds).not.toContain(ids.event);});
 it("only selected IDs and original versions are enriched; unrelated notes and screenshots are never read",async()=>{const result=await load(10);expect(m.queries.map(q=>q.table)).toEqual(["accounts","journal_analytics","trade_plans","strategy_versions","risk_plan_versions","trade_events"]);for(const q of m.queries.slice(2)){expect(q.filters).toContainEqual(["eq","account_id",ids.account]);expect(q.filters).toContainEqual(["eq","user_id",ids.user]);}expect(m.queries.find(q=>q.table==="trade_events")?.filters).toContainEqual(["in","plan_id",result.facts.sample.tradeIds]);expect(result.facts.trades).toHaveLength(10);});
 it("foreign/signed-out account cannot read a sample or silently fall back",async()=>{await expect(ownedRecentAccount(ids.image)).rejects.toThrow();m.rows.accounts[0].user_id=ids.image;await expect(ownedRecentAccount(ids.account)).rejects.toThrow();m.auth.mockRejectedValueOnce(new Error("signed out"));await expect(load()).rejects.toThrow();});
 it("empty sample has no context enrichment",async()=>{m.rows.journal_analytics=[];const r=await load();expect(r.facts.sample.actual).toBe(0);expect(m.queries).toHaveLength(2);});
 it.each([0,11,40,"20.0",null])("rejects unsupported sample %s",async n=>await expect(load(n)).rejects.toThrow());
 it("missing original version cannot silently remove an included trade",async()=>{m.rows.strategy_versions=[];await expect(load()).rejects.toThrow(/Original/);});
 it("database error fails closed",async()=>{m.errors.add("trade_events");await expect(load()).rejects.toThrow(/unavailable/);});
 it("event and text limits fail closed rather than sampling away evidence",async()=>{const event=m.rows.trade_events.at(-1);if(!event)throw new Error("Missing fixture event");m.rows.trade_events=Array(301).fill(event);await expect(load()).rejects.toThrow(/300-event/);m.rows.trade_events=[];m.rows.strategy_versions[0].written_rules="a".repeat(128001);await expect(load()).rejects.toThrow(/text size/);});
});
