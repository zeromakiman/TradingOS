// biome-ignore-all lint/suspicious/noArrayIndexKey: Persisted observations are immutable and never reordered.
import Link from "next/link";
import {ActionForm,Field} from "./forms";
import {requestWeeklyReview} from "@/app/weekly-review-actions";
import type {WeeklyReviewPanelData} from "@/lib/weekly-review-data";
import {euros} from "@/ai/budget";
export function WeeklyReviewPanel({data,requestKey}:{data:WeeklyReviewPanelData;requestKey:string}){
 const enabled=!data.error&&!data.scopeError&&!!data.facts?.trades.length&&data.availability.status==="ENABLED";
 const state=data.availability.status==="ACCOUNT_OFF"?"OFF":data.availability.status==="BUDGET_REACHED"?"BUDGET REACHED":data.availability.status==="ENABLED"?"ON":"UNAVAILABLE";
 const query=new URLSearchParams({account:data.account.id,week:data.period.startDate});
 return <section className="panel padded stack" aria-labelledby="weekly-review-title" style={{minWidth:0,overflowWrap:"anywhere"}}>
  <div><p className="eyebrow">AI ADVISORY — RISK ENGINE REMAINS AUTHORITATIVE</p><div className="row"><h2 id="weekly-review-title">Weekly Review</h2><span className="pill">{state}</span></div></div>
  <p>Review the recorded process, not the next market move. AI cannot change trading permission, plans, execution, realized R or EDGE calculations.</p>
  <form action="/edge/weekly" className="form-stack">
   <input type="hidden" name="account" value={data.account.id}/>
   <Field label="Choose a date in the week" hint="Monday–Sunday in fixed UTC−5. Select a completed week; no browser-local timezone or daylight saving changes."><input type="date" name="week" required min="2000-01-03" max="2099-12-31" defaultValue={data.period.startDate}/></Field>
   <button className="button button-outline" type="submit">Show week</button>
  </form>
  <div><h3>Selected week · {data.period.startDate} – {data.period.endDate}</h3><p className="small">Monday 00:00 through Sunday, ending next Monday 00:00 exclusive · fixed UTC−5.</p><p className="small">Exact UTC interval: {data.period.start} inclusive to {data.period.endExclusive} exclusive.</p></div>
  <p className="notice" style={{display:"block"}}>Maximum reservation: <strong style={{whiteSpace:"nowrap"}}>{euros(data.amount)}</strong> per review. Unused capacity is released after usage reconciliation.</p>
  {data.facts&&<div><h3>TRADING OS FACTS · CURRENT SNAPSHOT</h3><p>{data.facts.sample.count} completed trades · {data.facts.sample.label}</p><p role="note" className="notice" style={{display:"block"}}>{data.facts.sample.caveat}</p><p className="small">Net R: {data.facts.edge.netR??"No data"} · Expectancy: {data.facts.edge.expectancy??"No data"} · Existing deterministic EDGE calculation for this week only.</p></div>}
  {data.availability.status!=="ENABLED"&&<p role="status">{data.availability.message}</p>}
  {data.scopeError&&<p role="status">{data.scopeError}</p>}
  {data.error&&<p role="status">{data.error}</p>}
  {data.facts&&!data.facts.trades.length&&<p role="status">No completed trades in this week. No AI request can run.</p>}
  {enabled?<ActionForm action={requestWeeklyReview} requestKey={requestKey} label="Review this week" pendingLabel="Reviewing week…">
   <input type="hidden" name="accountId" value={data.account.id}/><input type="hidden" name="week" value={data.period.startDate}/>
   <p className="small">{data.facts?.scope} Nothing runs on page load. Each explicit run saves a new version.</p>
  </ActionForm>:<button type="button" className="button" disabled>Review this week</button>}
  <Link href={"/settings?account="+data.account.id}>AI controls and monthly budget</Link>
  <h3>Preserved weekly reviews</h3>
  {!data.history.length&&!data.error&&<p>No reviews saved for this week. Reruns append; they never overwrite earlier output.</p>}
  {data.history.map(c=>{const result=c.result,output=result?.interpretation,pending=!result&&Date.parse(c.deadline_at)>Date.now();return <article className="event stack" key={c.id} style={{minWidth:0,gap:16}}>
   <div><h4>{result?.status??(pending?"IN PROGRESS":"INCOMPLETE")}</h4><time dateTime={c.created_at}>{new Date(c.created_at).toISOString()} · UTC</time></div>
   {!result&&<p role="status">{pending?"Review in progress. Refresh for the saved result; no automatic provider retry occurs.":"This attempt did not finish saving. Any pending reservation remains protected. Check accounting before retrying."}</p>}
   {result?.status==="FAILED"&&<p role="status" className="notice amber" style={{display:"block"}}>Review failed · {result.error_code}. Previous versions are preserved. Uncertain accounting retains the protected reservation.</p>}
   <div><h4>TRADING OS FACTS</h4><p>{c.facts.period.startDate} – {c.facts.period.endDate} · fixed UTC−5 · {c.facts.sample.count} completed trades · {c.facts.sample.label}</p><p className="notice" style={{display:"block"}}>{c.facts.sample.caveat}</p><details><summary>Saved weekly facts, plans, executions and deterministic metrics</summary><pre className="code-data" style={{maxWidth:"100%",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(c.facts,null,2)}</pre></details></div>
   {output&&<div><p className="eyebrow">AI INTERPRETATION · ADVISORY ONLY</p>{([["WEEK SUMMARY",[output.weekSummary]],["PROCESS QUALITY",output.processQuality],["RULE ADHERENCE",output.ruleAdherence],["SETUP / MODEL PATTERNS",output.setupModelPatterns],["EXECUTION MISTAKES",output.executionMistakes],["BEHAVIORAL PATTERNS",output.behavioralPatterns],["WHAT IMPROVED",output.whatImproved],["WHAT NEEDS ATTENTION",output.needsAttention],["FOCUS FOR NEXT WEEK",output.focusNextWeek]] as const).map(([title,items])=><div key={title}><h4>{title}</h4><ul>{items.map((item,index)=><li key={index}><p>{item.text}</p><span className="small">Sources: {item.sourceRefs.join(", ")}</span></li>)}</ul></div>)}</div>}
   <details><summary>Provider, time and estimated cost</summary><dl className="data-list"><div><dt>Provider / model</dt><dd>{c.operation.provider} / {c.operation.model}</dd></div><div><dt>Operation version</dt><dd>{c.operation.version}</dd></div><div><dt>Recorded result · UTC</dt><dd>{result?new Date(result.created_at).toISOString():"Pending"}</dd></div><div><dt>Maximum reserved</dt><dd>{c.accounting?euros(c.accounting.reservedMicros):"No reservation recorded"}</dd></div><div><dt>Application-side estimated cost</dt><dd>{c.accounting?.usage?euros(c.accounting.usage.charged_micros)+" · "+c.accounting.usage.disposition:"Not reconciled"}</dd></div></dl><p className="small">Estimated budget accounting, not the provider's final invoice.</p></details>
  </article>;})}
  <nav aria-label="Weekly review history pages" className="row">{data.page>0&&<Link href={"/edge/weekly?"+query+"&page="+(data.page-1)}>Newer reviews</Link>}{data.hasOlder&&<Link href={"/edge/weekly?"+query+"&page="+(data.page+1)}>Older reviews</Link>}</nav>
 </section>;
}
