import "server-only";
import { z } from "zod";
import { requireUser } from "./supabase/server";
import { enrichTrades, journalRow, type JournalTrade } from "@/domain/analytics";

export async function loadJournalAnalytics(accountId?:string){
 const {db}=await requireUser();
 const {data,error}=await db.from("accounts").select("id,name").order("created_at");
 if(error)throw new Error("Unable to load accounts.");
 const accounts=z.array(z.object({id:z.uuid(),name:z.string()})).parse(data);
 const account=accounts.find(a=>a.id===accountId)??accounts[0];
 if(!account)return {accounts,account:null,trades:[]};
 const rows:JournalTrade[]=[];
 // Keyset pagination avoids PostgREST's 1000-row cap and shifting page offsets.
 let after:string|undefined;
 for(;;){
  let query=db.from("journal_analytics").select("*").eq("account_id",account.id).order("id").limit(500);
  if(after)query=query.gt("id",after);
  const result=await query;
  if(result.error)throw new Error("Journal outcomes require migration 0006. Existing plans and screenshots remain preserved.");
  const batch=z.array(journalRow).parse(result.data);rows.push(...batch);
  if(batch.length<500)break;after=batch[batch.length-1].id;
 }
 return {accounts,account,trades:enrichTrades(rows)};
}
