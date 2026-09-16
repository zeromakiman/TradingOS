import "server-only";
import { z } from "zod";
import { requireUser } from "./supabase/server";
import { journalRow } from "@/domain/analytics";
import type { JournalFilters } from "@/domain/ux";

export async function loadJournalPage(accountId: string | undefined, f: JournalFilters) {
  const {db} = await requireUser();
  const a = await db.from("accounts").select("id,name").order("created_at");
  if(a.error) throw new Error("Unable to load accounts. Please try again.");
  const accounts = z.array(z.object({id:z.uuid(),name:z.string()})).parse(a.data);
  const account = accounts.find(a=>a.id===accountId) ?? accounts[0];
  if(!account) return {accounts,account:null,rows:[],count:0,plannedRR:new Map<string,string>()};
  let query = db.from("journal_analytics").select("*", {count:"exact"}).eq("account_id",account.id);
  if(f.status) query=query.eq("status",f.status);
  if(f.outcome) query=query.eq("outcome",f.outcome);
  if(f.model) query=query.eq("entry_model",f.model);
  if(f.strategy) query=query.eq("strategy_version",f.strategy);
  if(f.from) query=query.gte("locked_at",`${f.from}T05:00:00Z`);
  if(f.to) query=query.lt("locked_at",new Date(Date.parse(`${f.to}T05:00:00Z`)+86400000).toISOString());
  if(f.q) query=z.uuid().safeParse(f.q).success?query.eq("id",f.q):query.ilike("instrument",`%${f.q.replace(/[_%]/g,"\\$&")}%`);
  const result=await query.order("locked_at",{ascending:false}).order("id",{ascending:false}).range(f.page*50,f.page*50+49);
  if(result.error)throw new Error("Unable to load the Journal. Please try again.");
  const rows=z.array(journalRow).parse(result.data),plannedRR=new Map<string,string>();
  if(rows.length){
    const plans=await db.from("trade_plans").select("id,risk_result->calculations").in("id",rows.map(r=>r.id));
    if(plans.error)throw new Error("Unable to load planned rewards. Please try again.");
    for(const p of z.array(z.object({id:z.uuid(),calculations:z.object({plannedRR:z.string()}).nullable()})).parse(plans.data))if(p.calculations)plannedRR.set(p.id,p.calculations.plannedRR);
  }
  return {accounts,account,rows,count:result.count??0,plannedRR};
}
