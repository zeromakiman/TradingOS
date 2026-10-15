// biome-ignore-all lint/suspicious/noArrayIndexKey: Saved analysis lists are immutable, never reordered or edited.
import {aiFailureAccountingMessage} from "@/ai/failure-accounting-message";
import Link from "next/link";
import {ActionForm} from "./forms";
import {requestAnalyzeSetup} from "@/app/analyze-setup-actions";
import type {AnalyzeSetupPanelData} from "@/lib/analyze-setup-data";
import {euros} from "@/ai/budget";
export function AnalyzeSetupPanel({proposalId,data,requestKey}:{proposalId:string;data:AnalyzeSetupPanelData;requestKey:string}){
 const enabled=!data.locked&&!data.error&&data.availability.status==="ENABLED";
 const state=data.availability.status==="ACCOUNT_OFF"?"OFF":data.availability.status==="BUDGET_REACHED"?"BUDGET REACHED":data.availability.status==="ENABLED"?"ON":"UNAVAILABLE";
 return <section className="panel padded" aria-labelledby="analyze-setup-title" style={{marginBlock:24,minWidth:0}}>
  <div className="eyebrow">AI ADVISORY — RISK ENGINE REMAINS AUTHORITATIVE</div>
  <div className="panel-heading" style={{flexWrap:"wrap",gap:12}}><h2 id="analyze-setup-title">Analyze setup</h2><span className="pill">{state}</span></div>
  <p>Organize and assess this setup objectively against the supplied strategy. Use Challenge my bias for a deliberate counter-argument. This is not trading permission.</p>
  <p className={`notice ${data.riskStatus==="TRADE_BLOCKED"?"amber":""}`} style={{display:"block"}}><strong>Risk Engine: {data.riskStatus==="TRADE_BLOCKED"?"BLOCKED":"APPROVED"} · saved check</strong><br/>AI cannot change this decision, RR, sizing, risk, the proposal or the lock. Locking always performs its own deterministic check.</p>
  <p className="notice" style={{display:"block"}}>Maximum reservation: <strong style={{whiteSpace:"nowrap"}}>{euros(data.amount)}</strong> per analysis. Unused capacity is released after usage reconciliation.</p>
  {data.locked&&<p role="status">Plan already locked. Earlier analyses remain advisory history; new analyses are unavailable.</p>}
  {data.availability.status!=="ENABLED"&&<p role="status">{data.availability.message}</p>}
  {data.error&&<p role="status">{data.error}</p>}
  {enabled?<ActionForm action={requestAnalyzeSetup} requestKey={requestKey} label="Analyze setup" pendingLabel="Analyzing setup…">
   <input type="hidden" name="proposalId" value={proposalId}/>
   <p className="small">Sends only this saved proposal, thesis, recorded strategy/session and Risk Engine output, plus checked screenshots. Unrecorded pre-market or liquidity claims remain unverified. No Journal, EDGE or other proposals are sent. Nothing runs when you open this page.</p>
   <fieldset><legend>Optional evidence · select up to 3</legend>{data.evidence.length?data.evidence.map(e=><label className="check-label" key={e.id} style={{overflowWrap:"anywhere"}}><input type="checkbox" name="evidence" value={e.id}/>{e.role} · {e.label}</label>):<p>No eligible screenshots. A text-only analysis is available.</p>}</fieldset>
  </ActionForm>:<button type="button" className="button" disabled>Analyze setup</button>}
  <h3 style={{marginTop:24}}>Preserved analyses</h3>
  {!data.history.length&&!data.error&&<p>No analyses yet. Each explicit run creates a separate history record.</p>}
  {data.history.map(c=>{const result=c.result,output=result?.interpretation,pending=!result&&Date.parse(c.deadline_at)>Date.now();return <article className="event" key={c.id} style={{minWidth:0,overflowWrap:"anywhere"}}>
   <h4>{result?.status??(pending?"IN PROGRESS":"INCOMPLETE")}</h4><time dateTime={c.created_at}>{new Date(c.created_at).toISOString()} · UTC</time>
   {!result&&<p role="status">{pending?"Analysis in progress. Refresh for the saved result; no automatic provider retry occurs.":"This attempt did not finish saving. Any pending reservation remains protected. Check accounting before retrying."}</p>}
   {result?.status==="FAILED"&&<p role="status" className="notice amber" style={{display:"block"}}>Analysis failed · {result.error_code}. Previous analyses are preserved. {aiFailureAccountingMessage(c.accounting)}</p>}
   <h4>TRADING OS FACTS</h4><h4>RISK ENGINE STATUS</h4><p>Recorded permission: <strong>{c.facts.deterministic.status==="TRADE_BLOCKED"?"BLOCKED":"APPROVED"}</strong>. This snapshot may differ from a later risk check.</p>
   <details><summary>Recorded proposal, strategy, session and risk facts</summary><pre className="code-data" style={{maxWidth:"100%",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(Object.fromEntries(Object.entries(c.facts).filter(([key])=>key!=="currentThesis")),null,2)}</pre></details>
   <h4>Recorded thesis</h4><p className="small">User-reported at the time of this analysis · unverified</p><p className="prose">{c.facts.currentThesis}</p>
   {output&&<div><p className="eyebrow">AI INTERPRETATION · ADVISORY ONLY</p>{output.evidenceStatus==="NONE_SELECTED"&&<p className="notice amber" style={{display:"block"}}>No visual evidence was selected. Chart patterns, liquidity events and model fit cannot be verified from the thesis alone.</p>}{([["SETUP STRUCTURE",[output.setupStructure]],["ENTRY MODEL ASSESSMENT",[output.entryModelAssessment]],["CONFLUENCES",output.confluences],["WEAKNESSES / MISSING EVIDENCE",output.weaknesses],["INVALIDATION",output.invalidation],["AI OBSERVATIONS",output.observations]] as const).map(([title,items])=><div key={title}><h4>{title}</h4><ul>{items.map((item,index)=><li key={index}><p>{item.text}</p><span className="small">Sources: {item.sourceRefs.join(", ")}</span></li>)}</ul></div>)}</div>}
   <details><summary>Provider, time and estimated cost</summary><dl className="data-list"><div><dt>Provider / model</dt><dd>{c.operation.provider} / {c.operation.model}</dd></div><div><dt>Operation version</dt><dd>{c.operation.version}</dd></div><div><dt>Recorded result</dt><dd>{result?new Date(result.created_at).toISOString():"Pending"}</dd></div><div><dt>Maximum reserved</dt><dd>{c.accounting?euros(c.accounting.reservedMicros):"No reservation recorded"}</dd></div><div><dt>Application-side estimated cost</dt><dd>{c.accounting?.usage?`${euros(c.accounting.usage.charged_micros)} · ${c.accounting.usage.disposition}`:"Not reconciled"}</dd></div></dl><p className="small">Estimated budget accounting, not the provider's final invoice.</p></details>
  </article>;})}
  <nav aria-label="Setup analysis history pages" style={{display:"flex",gap:16,flexWrap:"wrap"}}>{data.page>0&&<Link href={`/analyze/${proposalId}?analysisPage=${data.page-1}`}>Newer analyses</Link>}{data.hasOlder&&<Link href={`/analyze/${proposalId}?analysisPage=${data.page+1}`}>Older analyses</Link>}</nav>
 </section>;
}
