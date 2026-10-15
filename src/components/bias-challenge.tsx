// biome-ignore-all lint/suspicious/noArrayIndexKey: Saved challenge lists are immutable, never reordered or edited.
import {aiFailureAccountingMessage} from "@/ai/failure-accounting-message";
import Link from "next/link";
import {ActionForm} from "./forms";
import {requestBiasChallenge} from "@/app/bias-challenge-actions";
import type {BiasChallengePanelData} from "@/lib/bias-challenge-data";
import {euros} from "@/ai/budget";
export function BiasChallengePanel({proposalId,data,requestKey}:{proposalId:string;data:BiasChallengePanelData;requestKey:string}){
 const enabled=!data.locked&&!data.error&&data.availability.status==="ENABLED";
 const state=data.availability.status==="ACCOUNT_OFF"?"OFF":data.availability.status==="BUDGET_REACHED"?"BUDGET REACHED":data.availability.status==="ENABLED"?"ON":"UNAVAILABLE";
 return <section className="panel padded" aria-labelledby="bias-challenge-title" style={{marginBlock:24,minWidth:0}}>
  <div className="eyebrow">AI ADVISORY — NOT RISK ENGINE</div>
  <div className="panel-heading" style={{flexWrap:"wrap",gap:12}}><h2 id="bias-challenge-title">Challenge my bias</h2><span className="pill">{state}</span></div>
  <p>Challenge the reasoning behind this proposal before locking. This is not a trade signal or permission to trade.</p>
  <p className={`notice ${data.riskStatus==="TRADE_BLOCKED"?"amber":""}`} style={{display:"block"}}><strong>Risk Engine: {data.riskStatus==="TRADE_BLOCKED"?"BLOCKED":"APPROVED"} · saved check</strong><br/>AI cannot change this decision, RR, sizing, risk, the proposal or the lock. Locking always performs its own deterministic check.</p>
  <p className="notice" style={{display:"block"}}>Maximum reservation: <strong style={{whiteSpace:"nowrap"}}>{euros(data.amount)}</strong> per challenge. Unused capacity is released after usage reconciliation.</p>
  {data.locked&&<p role="status">Plan already locked. Earlier challenges remain advisory history; new challenges are unavailable.</p>}
  {data.availability.status!=="ENABLED"&&<p role="status">{data.availability.message}</p>}
  {data.error&&<p role="status">{data.error}</p>}
  {enabled?<ActionForm action={requestBiasChallenge} requestKey={requestKey} label="Challenge my bias" pendingLabel="Challenging your thesis…">
   <input type="hidden" name="proposalId" value={proposalId}/>
   <p className="small">Sends only this saved proposal, thesis, recorded strategy/session and Risk Engine output, plus checked screenshots. Unrecorded pre-market or liquidity claims remain unverified. No Journal, EDGE or other proposals are sent. Nothing runs when you open this page.</p>
   <fieldset><legend>Optional evidence · select up to 3</legend>{data.evidence.length?data.evidence.map(e=><label className="check-label" key={e.id} style={{overflowWrap:"anywhere"}}><input type="checkbox" name="evidence" value={e.id}/>{e.role} · {e.label}</label>):<p>No eligible screenshots. A text-only challenge is available.</p>}</fieldset>
  </ActionForm>:<button type="button" className="button" disabled>Challenge my bias</button>}
  <h3 style={{marginTop:24}}>Preserved challenges</h3>
  {!data.history.length&&!data.error&&<p>No challenges yet. Each explicit run creates a separate history record.</p>}
  {data.history.map(c=>{const result=c.result,output=result?.interpretation,pending=!result&&Date.parse(c.deadline_at)>Date.now();return <article className="event" key={c.id} style={{minWidth:0,overflowWrap:"anywhere"}}>
   <h4>{result?.status??(pending?"IN PROGRESS":"INCOMPLETE")}</h4><time dateTime={c.created_at}>{new Date(c.created_at).toISOString()} · UTC</time>
   {!result&&<p role="status">{pending?"Challenge in progress. Refresh for the saved result; no automatic provider retry occurs.":"This attempt did not finish saving. Any pending reservation remains protected. Check accounting before retrying."}</p>}
   {result?.status==="FAILED"&&<p role="status" className="notice amber" style={{display:"block"}}>Challenge failed · {result.error_code}. Previous challenges are preserved. {aiFailureAccountingMessage(c.accounting)}</p>}
   <h4>FACTS FROM TRADING OS</h4><p>Recorded Risk Engine permission: <strong>{c.facts.deterministic.status==="TRADE_BLOCKED"?"BLOCKED":"APPROVED"}</strong>. This snapshot may differ from a later risk check.</p>
   <details><summary>Recorded proposal, strategy, session and risk facts</summary><pre className="code-data" style={{maxWidth:"100%",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(Object.fromEntries(Object.entries(c.facts).filter(([key])=>key!=="currentThesis")),null,2)}</pre></details>
   <h4>YOUR CURRENT THESIS</h4><p className="small">User-reported at the time of this challenge · unverified</p><p className="prose">{c.facts.currentThesis}</p>
   {output&&<div><p className="eyebrow">AI ADVISORY — NOT RISK ENGINE</p><h4>COUNTER-ARGUMENT</h4><p className="prose">{output.counterArgument.text}</p><p className="small">Sources: {output.counterArgument.sourceRefs.join(", ")}</p>{([["WHAT COULD INVALIDATE THE SETUP",output.invalidation],["WHAT EVIDENCE IS MISSING / UNVERIFIED",output.missingEvidence],["QUESTIONS TO ANSWER BEFORE LOCKING",output.questions]] as const).map(([title,items])=><div key={title}><h4>{title}</h4><ul>{items.map((item,index)=><li key={index}><p>{item.text}</p><span className="small">Sources: {item.sourceRefs.join(", ")}</span></li>)}</ul></div>)}</div>}
   <details><summary>Provider, time and estimated cost</summary><dl className="data-list"><div><dt>Provider / model</dt><dd>{c.operation.provider} / {c.operation.model}</dd></div><div><dt>Operation version</dt><dd>{c.operation.version}</dd></div><div><dt>Recorded result</dt><dd>{result?new Date(result.created_at).toISOString():"Pending"}</dd></div><div><dt>Maximum reserved</dt><dd>{c.accounting?euros(c.accounting.reservedMicros):"No reservation recorded"}</dd></div><div><dt>Application-side estimated cost</dt><dd>{c.accounting?.usage?`${euros(c.accounting.usage.charged_micros)} · ${c.accounting.usage.disposition}`:"Not reconciled"}</dd></div></dl><p className="small">Estimated budget accounting, not the provider's final invoice.</p></details>
  </article>;})}
  <nav aria-label="Bias challenge history pages" style={{display:"flex",gap:16,flexWrap:"wrap"}}>{data.page>0&&<Link href={`/analyze/${proposalId}?challengePage=${data.page-1}`}>Newer challenges</Link>}{data.hasOlder&&<Link href={`/analyze/${proposalId}?challengePage=${data.page+1}`}>Older challenges</Link>}</nav>
 </section>;
}
