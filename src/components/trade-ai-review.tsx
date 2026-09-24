// biome-ignore-all lint/suspicious/noArrayIndexKey: Saved review lists are immutable, never reordered or edited.
import Link from "next/link";
import { ActionForm } from "./forms";
import { requestTradeReview } from "@/app/trade-review-actions";
import type { TradeReviewPanelData } from "@/lib/trade-review-data";
import { euros } from "@/ai/budget";
import { operationFor } from "@/ai/operations";

const titles={planAdherence:"Plan adherence",executionQuality:"Execution quality",modelFit:"Fit to your defined model",processDiscipline:"Risk and process discipline",deviations:"Plan versus execution",behavioralMistakes:"Possible behavioral mistakes"} as const;
export function TradeAiReview({planId,data,requestKey}:{planId:string;data:TradeReviewPanelData;requestKey:string}) {
 const enabled=data.closed&&!data.error&&data.availability.status==="ENABLED",op=operationFor("REVIEW_TRADE");
 const state=data.availability.status==="ACCOUNT_OFF"?"OFF":data.availability.status==="BUDGET_REACHED"?"BUDGET REACHED":data.availability.status==="ENABLED"?"ON":"UNAVAILABLE";
 return <section className="panel padded" aria-labelledby="trade-ai-review-title" style={{marginTop:24}}>
  <div className="panel-heading"><h2 id="trade-ai-review-title">Review this trade</h2><span className="pill">{state}</span></div>
  <p>Advisory review of this closed trade only. Risk, RR, realized R, locking and EDGE remain deterministic.</p>
  <p className="notice" style={{display:"block"}}>Maximum reservation: <strong style={{whiteSpace:"nowrap"}}>{euros(data.amount)}</strong> per review. Unused capacity is released after usage reconciliation. Each new review is preserved separately.</p>
  {!data.closed&&<p className="notice" role="status">Close this trade before requesting a post-trade review.</p>}
  {data.availability.status!=="ENABLED"&&<p className="notice" role="status">{data.availability.message}</p>}
  {data.error&&<p role="status">{data.error}</p>}
  {enabled?<ActionForm action={requestTradeReview} requestKey={requestKey} label="Review this trade" pendingLabel="Reviewing trade…">
   <input type="hidden" name="planId" value={planId}/>
   <p className="small">This sends this trade’s sealed plan, recorded strategy/risk versions, execution, deterministic result, notes/events/tags and only checked screenshots to {op.provider}. Other trades and account history are excluded. Nothing is sent when you open this page.</p>
   <fieldset><legend>Optional evidence · select up to {op.maxImages}</legend>{data.evidence.length?data.evidence.map(e=><label className="check-label" key={e.id} style={{overflowWrap:"anywhere"}}><input type="checkbox" name="evidence" value={e.id}/>{e.role} · {e.label}</label>):<p>No eligible screenshots. A text-only review is available.</p>}</fieldset>
  </ActionForm>:<button type="button" className="button" disabled>Review this trade</button>}
  <h3 style={{marginTop:24}}>Preserved reviews</h3>
  {!data.history.length&&!data.error&&<p>No AI reviews yet. Original trade records remain the source of truth.</p>}
  {data.history.map(review=>{
   const result=review.result,output=result?.interpretation;
   const pending=!result&&Date.parse(review.deadline_at)>Date.now();
   return <article key={review.id} className="event" style={{minWidth:0,overflowWrap:"anywhere"}}>
    <h4>{result?.status??(pending?"IN PROGRESS":"INCOMPLETE")}</h4><time dateTime={review.created_at}>{new Date(review.created_at).toISOString()} · UTC</time>
    {!result&&<p role="status">{pending?"Review is in progress. Refresh to check its saved result; do not submit it again.":"This attempt did not finish saving. Any pending reservation remains protected. No automatic provider retry occurs."}</p>}
    {result?.status==="FAILED"&&<p className="notice amber" role="status">Review failed · {result.error_code}. The original plan and previous reviews are unchanged. Accounting uncertainty keeps its reservation protected.</p>}
    <details><summary>FACTS FROM TRADING OS · preserved input snapshot</summary><p className="small">Recorded facts at the time of this request. No values below were generated or recalculated by AI. Later notes/tags may differ.</p><pre className="code-data" style={{maxWidth:"100%",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(review.facts,null,2)}</pre></details>
    {output&&<div><h4>AI INTERPRETATION</h4><p className="small">Advisory observations, including uncertainty and possible mistakes. These do not change any trade value or permission.</p>{Object.entries(titles).map(([key,title])=>{const item=output[key as keyof typeof titles];return <div key={key}><h5>{title} · {item.assessment.replaceAll("_"," ")}</h5><p className="prose">{item.interpretation}</p><p className="small">Sources: {item.sourceRefs.join(", ")}</p></div>;})}<h5>Useful lessons</h5><ul>{output.lessons.map((item,index)=><li key={index}><p>{item.interpretation}</p><span className="small">Sources: {item.sourceRefs.join(", ")}</span></li>)}</ul><h5>Limitations</h5><ul>{output.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></div>}
    <details><summary>Provider, time and estimated cost</summary><dl className="data-list"><div><dt>Provider / model</dt><dd>{review.operation.provider} / {review.operation.model}</dd></div><div><dt>Operation version</dt><dd>{review.operation.version}</dd></div><div><dt>Recorded result</dt><dd>{result?new Date(result.created_at).toISOString():"Pending"}</dd></div><div><dt>Maximum reserved</dt><dd>{review.accounting?euros(review.accounting.reservedMicros):"No reservation recorded"}</dd></div><div><dt>Application-side estimated cost</dt><dd>{review.accounting?.usage?`${euros(review.accounting.usage.charged_micros)} · ${review.accounting.usage.disposition}`:"Not reconciled"}</dd></div></dl><p className="small">Estimated budget accounting, not the provider’s final invoice.</p></details>
   </article>;
  })}
  <nav aria-label="AI review history pages" style={{display:"flex",gap:16,flexWrap:"wrap"}}>{data.page>0&&<Link href={`/journal/${planId}?reviewPage=${data.page-1}`}>Newer reviews</Link>}{data.hasOlder&&<Link href={`/journal/${planId}?reviewPage=${data.page+1}`}>Older reviews</Link>}</nav>
 </section>;
}
