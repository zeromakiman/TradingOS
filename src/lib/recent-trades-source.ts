import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {PLAN_SELECT,planRow,riskRow} from "./data";
import {journalRow} from "@/domain/analytics";
import {RECENT_LIMITS,recentTradesContext,recentSample} from "@/ai/recent-trades-context";
const eventRow=z.object({id:z.uuid(),plan_id:z.uuid(),event_type:z.string(),payload:z.record(z.string(),z.unknown()),occurred_at:z.string(),recorded_at:z.string()});
export class RecentScopeError extends Error {}
export async function ownedRecentAccount(accountId:string){
 const {db,user}=await requireUser();
 const a=await db.from("accounts").select("id,name").eq("id",z.uuid().parse(accountId)).eq("user_id",user.id).maybeSingle();
 if(a.error||!a.data)throw new Error("Account unavailable");
 return {db,user,account:z.object({id:z.uuid(),name:z.string()}).parse(a.data)};
}
export async function loadRecentFacts(owner:Awaited<ReturnType<typeof ownedRecentAccount>>,sample:unknown=20){
 const {db,user,account}=owner,requested=recentSample(sample),capturedAt=new Date().toISOString();
 const q=await db.from("journal_analytics").select("*",{count:"exact"}).eq("account_id",account.id).eq("status","CLOSED").not("realized_r","is",null).lte("exited_at",capturedAt).order("exited_at",{ascending:false}).order("id",{ascending:true}).limit(requested);
 if(q.error)throw new Error("Recent trades unavailable");
 const trades=z.array(journalRow).parse(q.data);
 const eligibleCount=z.number().int().min(trades.length).parse(q.count);
 if(!trades.length)return {facts:recentTradesContext(account.id,requested,[],capturedAt),eligibleCount};
 const ids=trades.map(t=>t.id),strategyIds=[...new Set(trades.map(t=>t.strategy_version_id))],riskIds=[...new Set(trades.map(t=>t.risk_plan_version_id))];
 const [p,s,r,e]=await Promise.all([
  db.from("trade_plans").select(PLAN_SELECT).eq("account_id",account.id).eq("user_id",user.id).in("id",ids),
  db.from("strategy_versions").select("id,version,rules,written_rules").eq("account_id",account.id).eq("user_id",user.id).in("id",strategyIds),
  db.from("risk_plan_versions").select("id,version,effective_day,max_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text").eq("account_id",account.id).eq("user_id",user.id).in("id",riskIds),
  db.from("trade_events").select("id,plan_id,event_type,payload,occurred_at,recorded_at").eq("account_id",account.id).eq("user_id",user.id).in("plan_id",ids).lte("occurred_at",capturedAt).lte("recorded_at",capturedAt).order("sequence").limit(RECENT_LIMITS.events+1),
 ]);
 if([p,s,r,e].some(x=>x.error))throw new Error("Recent context unavailable");
 const plans=z.array(planRow).parse(p.data),strategies=z.array(z.object({id:z.uuid(),version:z.string(),rules:z.record(z.string(),z.unknown()),written_rules:z.string()})).parse(s.data),risks=z.array(riskRow).parse(r.data),events=z.array(eventRow).parse(e.data);
 if(events.length>RECENT_LIMITS.events)throw new RecentScopeError("This sample exceeds the 300-event analysis limit. Nothing was sent; no events were silently omitted.");
 const facts=recentTradesContext(account.id,requested,trades.map(trade=>{
  const plan=plans.find(x=>x.id===trade.id),strategy=strategies.find(x=>x.id===trade.strategy_version_id),risk=risks.find(x=>x.id===trade.risk_plan_version_id);
  if(!plan||!strategy||!risk)throw new Error("Original recent records unavailable");
  return {plan,trade,strategy,risk,events:events.filter(x=>x.plan_id===trade.id).map(({plan_id:_,...event})=>event)};
 }),capturedAt);
 if(Buffer.byteLength(JSON.stringify(facts))>RECENT_LIMITS.bytes)throw new RecentScopeError("This sample exceeds the bounded text size. Nothing was sent; the analysis cannot silently truncate records.");
 return {facts,eligibleCount};
}
