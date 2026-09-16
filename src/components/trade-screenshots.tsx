// biome-ignore-all lint/performance/noImgElement: Session-authenticated private evidence must not enter an image cache.
import Link from "next/link";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { ActionForm } from "./forms";
import { importLockedSetup } from "@/app/setup-actions";
export async function TradeScreenshots({planId}:{planId:string}){
 const {db}=await requireUser();
 const link=await db.from("setup_locks").select("proposal_id").eq("plan_id",planId).maybeSingle();
 if(link.error)throw new Error("Unable to load screenshot history.");
 if(!link.data)return <section className="panel padded"><h2>Screenshots</h2><p>No screenshots attached. Open the screenshot workspace to add private chart evidence to this locked plan.</p><ActionForm action={importLockedSetup} label="Add screenshots"><input type="hidden" name="planId" value={planId}/></ActionForm></section>;
 const id=z.object({proposal_id:z.uuid()}).parse(link.data).proposal_id;
 const images=await db.from("setup_screenshots").select("id,role,original_filename").eq("proposal_id",id).order("uploaded_at");
 if(images.error)throw new Error("Unable to load screenshots.");
 const rows=z.array(z.object({id:z.uuid(),role:z.string(),original_filename:z.string()})).parse(images.data);
 return <section className="panel padded"><h2>Private screenshots · {rows.length}</h2><p>All preserved attachments, including charts excluded from later reviews.</p><div className="chart-grid">{rows.map(i=><a className="chart-card" key={i.id} href={`/api/screenshots/${i.id}`} target="_blank" rel="noreferrer"><img loading="lazy" src={`/api/screenshots/${i.id}`} alt={`${i.role} chart: ${i.original_filename}`}/><span>{i.role} · {i.original_filename}</span></a>)}</div>{!rows.length&&<p>No screenshots yet. Add chart evidence in the screenshot workspace.</p>}<Link className="button button-outline" href={`/analyze/${id}`}>Manage screenshots & evaluation history →</Link></section>;
}
