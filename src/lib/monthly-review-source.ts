import "server-only";
import {z} from "zod";
import {requireUser} from "./supabase/server";
import {PLAN_SELECT,planRow,riskRow} from "./data";
import {journalRow} from "@/domain/analytics";
import {monthlyPeriod} from "@/ai/monthly-period";
import {MONTHLY_LIMITS,monthlyReviewContext} from "@/ai/monthly-review-context";
const eventRow=z.object({id:z.uuid(),plan_id:z.uuid(),event_type:z.string(),payload:z.record(z.string(),z.unknown()),occurred_at:z.string(),recorded_at:z.string()});
export class MonthlyScopeError extends Error {}
export async function ownedMonthlyAccount(accountId:string){
 const {db,user}=await requireUser();
 const a=await db.from("accounts").select("id,name").eq("id",z.uuid().parse(accountId)).eq("user_id",user.id).maybeSingle();
 if(a.error||!a.data)throw new Error("Account unavailable");
 return {db,user,account:z.object({id:z.uuid(),name:z.string()}).parse(a.data)};
}
export async function loadMonthlyFacts(owner:Awaited<ReturnType<typeof ownedMonthlyAccount>>,month:string){
 const {db,user,account}=owner,period=monthlyPeriod(month),capturedAt=new Date().toISOString();
 if(Date.parse(period.endExclusive)>Date.parse(capturedAt))throw new MonthlyScopeError("Choose a completed month. Monthly Review starts at the next first day, 00:00 fixed UTC−5.");
 const q=await db.from("journal_analytics").select("*").eq("account_id",account.id).eq("status","CLOSED").gte("exited_at",period.start).lt("exited_at",period.endExclusive).order("exited_at").order("id").limit(MONTHLY_LIMITS.trades+1);
 if(q.error)throw new Error("Monthly trades unavailable");
 const trades=z.array(journalRow).parse(q.data);
 if(trades.length>MONTHLY_LIMITS.trades)throw new MonthlyScopeError("This month exceeds the 120-trade review limit. Nothing was sent; no trades were silently omitted.");
 if(!trades.length)return monthlyReviewContext(account.id,month,[],capturedAt);
 const ids=trades.map(t=>t.id),strategyIds=[...new Set(trades.map(t=>t.strategy_version_id))],riskIds=[...new Set(trades.map(t=>t.risk_plan_version_id))];
 const [p,s,r,e]=await Promise.all([
  db.from("trade_plans").select(PLAN_SELECT).eq("account_id",account.id).eq("user_id",user.id).in("id",ids),
  db.from("strategy_versions").select("id,version,rules,written_rules").eq("account_id",account.id).eq("user_id",user.id).in("id",strategyIds),
  db.from("risk_plan_versions").select("id,version,effective_day,max_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text").eq("account_id",account.id).eq("user_id",user.id).in("id",riskIds),
  db.from("trade_events").select("id,plan_id,event_type,payload,occurred_at,recorded_at").eq("account_id",account.id).eq("user_id",user.id).in("plan_id",ids).gte("occurred_at",period.start).lt("occurred_at",period.endExclusive).gte("recorded_at",period.start).lt("recorded_at",period.endExclusive).order("sequence").limit(MONTHLY_LIMITS.events+1),
 ]);
 if([p,s,r,e].some(x=>x.error))throw new Error("Monthly context unavailable");
 const plans=z.array(planRow).parse(p.data),strategies=z.array(z.object({id:z.uuid(),version:z.string(),rules:z.record(z.string(),z.unknown()),written_rules:z.string()})).parse(s.data),risks=z.array(riskRow).parse(r.data),events=z.array(eventRow).parse(e.data);
 if(events.length>MONTHLY_LIMITS.events)throw new MonthlyScopeError("This month exceeds the 500-event review limit. Nothing was sent; no events were silently omitted.");
 const facts=monthlyReviewContext(account.id,month,trades.map(trade=>{
  const plan=plans.find(x=>x.id===trade.id),strategy=strategies.find(x=>x.id===trade.strategy_version_id),risk=risks.find(x=>x.id===trade.risk_plan_version_id);
  if(!plan||!strategy||!risk)throw new Error("Original monthly records unavailable");
  return {plan,trade,strategy,risk,events:events.filter(x=>x.plan_id===trade.id).map(({plan_id:_,...event})=>event)};
 }),capturedAt);
 if(Buffer.byteLength(JSON.stringify(facts))>MONTHLY_LIMITS.bytes)throw new MonthlyScopeError("Even the deterministic summary exceeds the bounded text size. Nothing was sent; no partial month was selected.");
 return facts;
}
