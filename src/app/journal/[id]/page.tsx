import Link from "next/link";
import { TradeScreenshots } from "@/components/trade-screenshots";
import { journalReturnPath, utcTime, eventSummary } from "@/domain/ux";
import { JournalOutcome } from "@/components/journal-outcome";
import { journalRow } from "@/domain/analytics";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Shell } from "@/components/shell";
import { requireUser } from "@/lib/supabase/server";
import { planRow, PLAN_SELECT } from "@/lib/data";
import { ActionForm, Field } from "@/components/forms";
import { addNote } from "@/app/actions";

export const dynamic = "force-dynamic";
export default async function PlanPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{returnTo?:string}>}) {
  const back=journalReturnPath((await searchParams).returnTo);
  const {id} = await params; if (!z.uuid().safeParse(id).success) notFound();
  const {db} = await requireUser();
  const {data,error} = await db.from("trade_plans").select(PLAN_SELECT).eq("id",id).maybeSingle();
  if (error) throw new Error("Unable to load plan."); if (!data) notFound();
  const p = planRow.parse(data);
  const outcome = await db.from("journal_analytics").select("*").eq("id",id).single();
  if(outcome.error)throw new Error("Unable to load journal outcome. Apply migration 0006.");
  const trade=journalRow.parse(outcome.data);
  const {data:events,error:eventError} = await db.from("trade_events").select("id,event_type,payload,occurred_at,recorded_at,sequence").eq("plan_id",id).order("sequence");
  if (eventError) throw new Error("Unable to load audit events.");
  const history = z.array(z.object({id:z.string(),event_type:z.string(),payload:z.record(z.string(),z.unknown()),occurred_at:z.string(),recorded_at:z.string()})).parse(events);
  return <Shell active="Journal" accountId={p.account_id}><Link className="block" style={{marginBottom:16}} href={back==="/journal"?`/journal?account=${p.account_id}`:back}>← Back to Journal</Link><div className="page-heading"><div><div className="eyebrow">IMMUTABLE ORIGINAL · {utcTime(p.locked_at)}</div><h1>{p.instrument.symbol} · {String(p.proposal.direction)} · {String(p.proposal.model).replaceAll("_"," ")}</h1><p>Plan {p.id}</p></div><span className="pill success">{trade.status}</span></div><div className="notice" style={{marginBottom:24}}>The original plan is locked. Record actual execution and later observations below; original values remain unchanged.</div><div className="content-grid"><div className="stack"><section className="panel"><div className="panel-heading"><h2>Planned · original locked values</h2></div><dl className="data-list padded">{[["entry","Entry price"],["stop","Stop loss"],["target","Target price"],["riskPercent","Risk (%)"],["news","News context"]].map(([key,label])=><div key={key}><dt>{label}</dt><dd>{key==="riskPercent"?Number(p.proposal[key]).toFixed(2)+"%":String(p.proposal[key])}</dd></div>)}<div><dt>Planned reward / risk</dt><dd>{p.risk_result.calculations?Number(p.risk_result.calculations.plannedRR).toFixed(2)+"R":"—"}</dd></div><div><dt>Initial nominal risk</dt><dd>${Number(p.nominal_risk).toFixed(2)}</dd></div><div><dt>Strategy version</dt><dd className="small">{p.strategy.version}</dd></div><div><dt>Risk-plan version</dt><dd className="small">{p.risk.version}</dd></div></dl></section><JournalOutcome trade={trade}/><TradeScreenshots planId={id}/><section className="panel padded"><h2 style={{marginBottom:16}}>What I believed before entry</h2><p className="prose">{String(p.proposal.narrative)}</p></section><details className="panel padded"><summary>Preserved deterministic risk report</summary><pre className="code-data">{JSON.stringify(p.risk_result,null,2)}</pre></details></div><section className="panel"><div className="panel-heading"><h2>Events & audit history</h2></div><div className="padded">{history.map(e=><article key={e.id} className="event"><strong>{e.event_type.replaceAll("_"," ")}</strong><small>Occurred: {utcTime(e.occurred_at)}<br/>Recorded: {utcTime(e.recorded_at)}</small><p className="prose">{eventSummary(e.event_type,e.payload)}</p><details><summary>Original event data</summary><pre className="code-data">{JSON.stringify(e.payload,null,2)}</pre></details></article>)}<div style={{marginTop:28}}><ActionForm action={addNote} requestKey={crypto.randomUUID()} guardUnsaved label="Add note" pendingLabel="Adding note…"><input type="hidden" name="planId" value={id}/><Field label="New observation"><textarea name="note" required rows={4} maxLength={5000} placeholder="Record new information without rewriting the original."/></Field></ActionForm></div></div></section></div></Shell>;
}


