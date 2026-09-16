import Link from "next/link";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { utcTime } from "@/domain/ux";
export async function SetupJournal({accountId,page}:{accountId:string;page:number}){
 const {db}=await requireUser();
 const {data,error}=await db.from("setup_proposals").select("id,proposal->direction,proposal->model,created_at,instrument:instrument_versions(symbol),locks:setup_locks(plan_id)").eq("account_id",accountId).order("created_at",{ascending:false}).order("id",{ascending:false}).range(page*50,page*50+49);
 if(error)throw new Error("Unable to load saved proposals. Please try again.");
 const rows=z.array(z.object({id:z.uuid(),direction:z.string(),model:z.string(),created_at:z.string(),instrument:z.object({symbol:z.string()}),locks:z.array(z.object({plan_id:z.uuid()}))})).parse(data);
 return <details className="panel padded"><summary>Saved proposals & screenshots · page {page+1}</summary><p className="small">Proposals preserve reasoning and screenshots. Risk is reserved only when locked. Evaluation history is available in each record.</p><div className="record-grid">{rows.map(p=><article className="chart-card" key={p.id}><strong>{p.instrument.symbol} · {p.direction}</strong><p>{p.model.replaceAll("_"," ")} · {p.locks.length?"LOCKED":"PROPOSED"}</p><p className="small">{utcTime(p.created_at)}</p><Link href={`/analyze/${p.id}`}>Open proposal & screenshots →</Link></article>)}</div>{!rows.length&&<p>No saved proposals yet. Save a new trade proposal to add screenshots.</p>}<nav className="row" aria-label="Proposal pages">{page>0&&<Link href={`/journal?account=${accountId}&proposals=${page-1}`}>← Newer proposals</Link>}{rows.length===50&&<Link href={`/journal?account=${accountId}&proposals=${page+1}`}>Older proposals →</Link>}</nav></details>;
}
