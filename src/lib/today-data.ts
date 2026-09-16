import "server-only";
import Decimal from "decimal.js";
import { z } from "zod";
import { requireUser } from "./supabase/server";
export async function loadTodayActivity(accountId:string,day:string){
 const {db}=await requireUser(),from=`${day}T05:00:00Z`,to=new Date(Date.parse(from)+86400000).toISOString();
 const [entries,active]=await Promise.all([
  db.from("journal_analytics").select("id",{count:"exact",head:true}).eq("account_id",accountId).gte("entered_at",from).lt("entered_at",to),
  db.from("journal_analytics").select("id,instrument,direction,status,execution_id,locked_at").eq("account_id",accountId).in("status",["LOCKED","TAKEN"]).order("execution_id",{ascending:false,nullsFirst:false}).order("locked_at",{ascending:false}).order("id",{ascending:false}).limit(6)
 ]);
 if(entries.error||active.error)throw new Error("Unable to load today’s activity. Please try again.");
 let sum=new Decimal(0),after:string|undefined,closed=0;
 for(;;){
  let query=db.from("journal_analytics").select("id,realized_r").eq("account_id",accountId).eq("status","CLOSED").gte("exited_at",from).lt("exited_at",to).order("id").limit(500);
  if(after)query=query.gt("id",after);
  const result=await query;if(result.error)throw new Error("Unable to load today’s results.");
  const rows=z.array(z.object({id:z.uuid(),realized_r:z.string()})).parse(result.data);
  for(const row of rows)sum=sum.plus(row.realized_r);closed+=rows.length;
  if(rows.length<500)break;after=rows[rows.length-1].id;
 }
 return {taken:entries.count??0,closed,result:sum.toFixed(),active:z.array(z.object({id:z.uuid(),instrument:z.string(),direction:z.string(),status:z.enum(["LOCKED","TAKEN"]),execution_id:z.uuid().nullable(),locked_at:z.string()})).parse(active.data)};
}
