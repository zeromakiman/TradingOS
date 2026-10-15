import { operationFor } from "@/ai/operations";
import { ActionForm, Field } from "./forms";
import { saveAiActivation, saveAiBudget } from "@/app/ai-settings-actions";
import { euros } from "@/ai/budget";
import type { loadAiBudget } from "@/lib/ai-budget";

export function AiSettings({accountId,data}:{accountId:string;data:Awaited<ReturnType<typeof loadAiBudget>>}) {
 const operation=operationFor("SETUP_ANALYSIS");
 const {snapshot:b,presentation:p,system}=data;
 return <section className="panel padded" style={{marginBottom:24}} aria-labelledby="ai-settings-title">
  <div className="panel-heading"><h2 id="ai-settings-title">AI analysis</h2><strong className="pill">{p?.state??"UNAVAILABLE"}</strong></div>
  <p>AI is advisory. Risk, trade locking and performance calculations remain deterministic.</p>
  {system.status!=="ENABLED"&&<p className="notice" role="status">{system.message}</p>}
  {data.error&&<p className="notice amber" role="status">{data.error}</p>}
  {b&&p&&<>
   <dl className="form-grid"><div><dt>Monthly spending limit · EUR</dt><dd>{euros(b.budgetCents*10000)}</dd></div><div><dt>Estimated used this month</dt><dd>{euros(b.usedMicros)}</dd></div><div><dt>Reserved / pending</dt><dd>{euros(b.heldMicros)}</dd></div><div><dt>Estimated remaining</dt><dd>{euros(p.remainingMicros)}</dd></div></dl>
   <p><strong>{p.percentage}% committed</strong> · {p.warning}</p>
   <progress aria-label="AI monthly budget committed" value={Math.min(100,p.percentage)} max={100} style={{width:"100%"}}/>
   <p className="small">Next reset: <time dateTime={b.resetAt}>{new Date(Date.parse(b.resetAt)-5*3600000).toISOString().slice(0,16).replace("T"," ")} UTC−5</time>. Calendar months begin on day 1 at 00:00 fixed UTC−5 (05:00 UTC); no daylight-saving adjustment. History is preserved.</p>
   <p className="small">Application-side estimated cost, not the provider’s final invoice. Pending requests reduce remaining capacity. Provider: {operation.provider} · {operation.model}.</p>
   <p className="notice">A normal analysis reserves up to {euros(data.reservationMicros)}. A lower remaining budget blocks the request. Deep Review uses three separately authorized passes; its reconciliation pass has a larger input allowance. Unused reservation is released after authoritative usage is recorded. The cap is never raised automatically.</p>
   {b.uncertain&&<p className="notice amber">Accounting review required: uncertain requests retain their full reservation. AI remains unavailable until an operator resolves the discrepancy.</p>}
   <div className="content-grid"><div>
    <h3>Account permission · {b.enabled?"opted in":"opted out"}</h3>
    {b.enabled?<ActionForm action={saveAiActivation} label="Disable AI"><input type="hidden" name="accountId" value={accountId}/><input type="hidden" name="enabled" value="false"/><p>Stops future requests, including later passes of a review. Already dispatched requests may finish and be charged. Historical evaluations remain available.</p></ActionForm>:system.status==="ENABLED"&&!b.uncertain?<details><summary>Enable AI for this account…</summary><ActionForm action={saveAiActivation} label="Confirm and enable AI"><input type="hidden" name="accountId" value={accountId}/><input type="hidden" name="enabled" value="true"/><p>When you explicitly request analysis, selected screenshots, your proposal and narrative, strategy context, deterministic risk outputs and prior review output may be sent to the configured AI provider. Opening a page does not request analysis.</p><label className="check-label"><input type="checkbox" name="confirm" required/>I understand and explicitly consent to sending this selected information for AI analysis.</label></ActionForm></details>:<p>Activation is unavailable. Your preference remains OFF.</p>}
   </div><div><h3>Monthly budget</h3><ActionForm action={saveAiBudget} label="Save monthly AI budget"><input type="hidden" name="accountId" value={accountId}/><Field label="Monthly AI budget (EUR)" hint="€1.00–€100.00. Examples: €3, €5 or €10. No unlimited option."><input name="budget" type="number" min="1" max="100" step="0.01" list="ai-budget-presets" required defaultValue={(b.budgetCents/100).toFixed(2)}/><datalist id="ai-budget-presets"><option value="3"/><option value="5"/><option value="10"/></datalist></Field><p className="small">Lowering below committed usage blocks further requests. Raising the cap never enables AI by itself.</p></ActionForm></div></div>
   <details style={{marginTop:20}}><summary>AI preference and budget audit · latest 12 changes</summary>{data.events.length?data.events.map(e=><article className="event" key={e.id}><strong>{e.previous_enabled?"ON":"OFF"} → {e.enabled?"ON":"OFF"} · {euros(e.previous_budget_cents*10000)} → {euros(e.budget_cents*10000)}</strong><time dateTime={e.created_at} style={{display:"block",marginTop:4}}>{new Date(e.created_at).toISOString()} · UTC</time><p className="small">Changed by this account’s authenticated owner.</p></article>):<p>No changes. Default: OFF with a €5.00 monthly cap.</p>}</details>
  </>}
 </section>;
}
