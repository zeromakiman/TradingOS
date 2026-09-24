// biome-ignore-all lint/suspicious/noArrayIndexKey: Persisted observations are immutable and never reordered.
import Link from "next/link";
import {ActionForm,Field} from "./forms";
import {requestRecentTrades} from "@/app/recent-trades-actions";
import type {RecentTradesPanelData} from "@/lib/recent-trades-data";
import {euros} from "@/ai/budget";
export function RecentTradesPanel({data,requestKey}:{data:RecentTradesPanelData;requestKey:string}){
 const enabled=!data.error&&!data.scopeError&&!!data.facts?.trades.length&&data.availability.status==="ENABLED";
 const state=data.availability.status==="ACCOUNT_OFF"?"OFF":data.availability.status==="BUDGET_REACHED"?"BUDGET REACHED":data.availability.status==="ENABLED"?"ON":"UNAVAILABLE";
 const query=new URLSearchParams({account:data.account.id,sample:String(data.requested)});
 return <section className="panel padded stack" aria-labelledby="recent-trades-title" style={{minWidth:0,overflowWrap:"anywhere"}}>
  <div><p className="eyebrow">AI ADVISORY — RISK ENGINE REMAINS AUTHORITATIVE</p><div className="row"><h2 id="recent-trades-title">Recent-Trades Analysis</h2><span className="pill">{state}</span></div></div>
  <p>Look for recurring patterns across the latest completed trades, regardless of calendar weeks. AI cannot change trading permission, plans, execution, realized R or EDGE calculations.</p>
  <form action="/edge/recent" className="form-stack">
   <input type="hidden" name="account" value={data.account.id}/>
   <Field label="Completed trade sample" hint="Press Show sample to apply your selection. Newest persisted exit first; trade ID breaks exact ties. Calendar weeks do not affect selection."><select name="sample" defaultValue={String(data.requested)}>{[10,20,30].map(n=><option key={n} value={n}>Last {n} trades</option>)}</select></Field>
   <button className="button button-outline" type="submit">Show sample</button>
  </form>
  <div><h3>SAMPLE · Last {data.requested} completed trades</h3><p>Eligible completed trades: {data.eligibleCount??"Unavailable"}. Selected for the next analysis: {data.facts?.sample.actual??"Unavailable"}.</p><p className="small">The server refreshes selection when you explicitly submit. Exact analyzed IDs remain attached to each saved result.</p></div>
  <p className="notice" style={{display:"block"}}>Maximum reservation: <strong style={{whiteSpace:"nowrap"}}>{euros(data.amount)}</strong> per analysis. Unused capacity is released after usage reconciliation.</p>
  {data.facts&&<div><h3>TRADING OS FACTS · CURRENT SNAPSHOT</h3><p>{data.facts.sample.actual} completed trades · {data.facts.sample.label}</p><p role="note" className="notice" style={{display:"block"}}>{data.facts.sample.caveat}</p><p className="small">Net R: {data.facts.edge.netR??"No data"} · Expectancy: {data.facts.edge.expectancy??"No data"} · Existing deterministic EDGE calculation for this selected sample only.</p></div>}
  {data.availability.status!=="ENABLED"&&<p role="status">{data.availability.message}</p>}
  {data.scopeError&&<p role="status">{data.scopeError}</p>}
  {data.error&&<p role="status">{data.error}</p>}
  {data.facts&&!data.facts.trades.length&&<p role="status">No completed trades in this sample. No AI request can run.</p>}
  {enabled?<ActionForm action={requestRecentTrades} requestKey={requestKey} label="Analyze recent trades" pendingLabel="Analyzing trades…">
   <input type="hidden" name="accountId" value={data.account.id}/><input type="hidden" name="sample" value={data.requested}/>
   <p className="small">{data.facts?.scope} Nothing runs on page load. Each explicit run saves a new version.</p>
  </ActionForm>:<button type="button" className="button" disabled>Analyze recent trades</button>}
  <Link href={"/settings?account="+data.account.id}>AI controls and monthly budget</Link>
  <h3>Preserved recent-trades analyses</h3>
  {!data.history.length&&!data.error&&<p>No analyses saved for this sample size. Reruns append; they never overwrite earlier output.</p>}
  {data.history.map(c=>{const result=c.result,output=result?.interpretation,pending=!result&&Date.parse(c.deadline_at)>Date.now();return <article className="event stack" key={c.id} style={{minWidth:0,gap:16}}>
   <div><h4>{result?.status??(pending?"IN PROGRESS":"INCOMPLETE")}</h4><time dateTime={c.created_at}>{new Date(c.created_at).toISOString()} · UTC</time></div>
   {!result&&<p role="status">{pending?"Analysis in progress. Refresh for the saved result; no automatic provider retry occurs.":"This attempt did not finish saving. Any pending reservation remains protected. Check accounting before retrying."}</p>}
   {result?.status==="FAILED"&&<p role="status" className="notice amber" style={{display:"block"}}>Analysis failed · {result.error_code}. Previous versions are preserved. Uncertain accounting retains the protected reservation.</p>}
   <div><h4>SAMPLE</h4><p>Requested {c.facts.sample.requested} · Actually analyzed {c.facts.sample.actual} completed trades · {c.facts.sample.label}</p><p className="notice" style={{display:"block"}}>{c.facts.sample.caveat}</p><h4>TRADING OS FACTS</h4><details><summary>Saved sample, exact trade IDs, plans, executions and deterministic metrics</summary><pre className="code-data" style={{maxWidth:"100%",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(c.facts,null,2)}</pre></details></div>
   {output&&<div><p className="eyebrow">AI INTERPRETATION · ADVISORY ONLY</p>{([["RECURRING STRENGTHS",output.strengths],["RECURRING EXECUTION MISTAKES",output.executionMistakes],["ENTRY MODEL PATTERNS",output.entryModelPatterns],["SESSION PATTERNS",output.sessionPatterns],["RISK / PROCESS DISCIPLINE",output.processDiscipline],["BEHAVIORAL PATTERNS",output.behavioralPatterns],["OUTLIERS",output.outliers],["WHAT TO MONITOR NEXT",output.monitorNext]] as const).map(([title,items])=><div key={title}><h4>{title}</h4><ul>{items.map((item,index)=><li key={index}><p>{item.text}</p><span className="small">Sources: {item.sourceRefs.join(", ")}</span></li>)}</ul></div>)}</div>}
   <details><summary>Provider, time and estimated cost</summary><dl className="data-list"><div><dt>Provider / model</dt><dd>{c.operation.provider} / {c.operation.model}</dd></div><div><dt>Operation version</dt><dd>{c.operation.version}</dd></div><div><dt>Recorded result · UTC</dt><dd>{result?new Date(result.created_at).toISOString():"Pending"}</dd></div><div><dt>Maximum reserved</dt><dd>{c.accounting?euros(c.accounting.reservedMicros):"No reservation recorded"}</dd></div><div><dt>Application-side estimated cost</dt><dd>{c.accounting?.usage?euros(c.accounting.usage.charged_micros)+" · "+c.accounting.usage.disposition:"Not reconciled"}</dd></div></dl><p className="small">Estimated budget accounting, not the provider's final invoice.</p></details>
  </article>;})}
  <nav aria-label="Recent-trades analysis history pages" className="row">{data.page>0&&<Link href={"/edge/recent?"+query+"&page="+(data.page-1)}>Newer analyses</Link>}{data.hasOlder&&<Link href={"/edge/recent?"+query+"&page="+(data.page+1)}>Older analyses</Link>}</nav>
 </section>;
}
