"use client";
import { proposalFeedback } from "@/domain/ux";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { ArrowRight, Check, CircleAlert, LockKeyhole, ShieldCheck } from "lucide-react";
import { evaluateRisk, type Instrument, type Proposal, type RiskContext } from "@/domain/risk";
import { strategyClock } from "@/domain/session";
import {isRiskReportCurrent, type RiskReport} from "@/domain/risk-report";
import { evaluatePlan, lockPlan } from "@/app/actions";
import { saveSetup } from "@/app/setup-actions";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { useUnsavedChanges } from "./unsaved-changes";
import { Field } from "./forms";

export function TradeWorkspace({ context, instruments, accountId, observationId, preview = false }: { context: RiskContext; instruments: Instrument[]; accountId?: string; observationId?: string; preview?: boolean }) {
  const router=useRouter();
  const [proposal, setProposal] = useState<Proposal>({ instrumentId: instruments[0].id, direction: "LONG", model: "OB_FIRST_TOUCH", entry: preview ? "1.10000" : "", stop: preview ? "1.09800" : null, target: preview ? "1.10600" : "", riskPercent: context.plan.maxRiskPercent, narrative: preview ? "Example only: proposed first-touch OB after a liquidity sweep and meaningful M5 displacement. Chart evidence has not been supplied." : "", contractConfirmed: false, news: "UNKNOWN", contradiction: false });
  const [dirty,setDirty]=useState(false);
  const [now, setNow] = useState(context.now);
  const [simulation, setSimulation] = useState("ACTIVE");
  const [submitted, setSubmitted] = useState(false);
  const [serverResult, setServerResult] = useState<RiskReport | null>(null);
  const [evaluationId, setEvaluationId] = useState<string>();
  const [operation, setOperation] = useState("check");
  const [planId, setPlanId] = useState<string>();
  const [requestKey, setRequestKey] = useState<string>();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const unsavedDialog=useUnsavedChanges(dirty&&!planId&&!pending);
  useEffect(() => { if (preview) return; const timer = setInterval(() => setNow(new Date().toISOString()), 1000); return () => clearInterval(timer); }, [preview]);
  const instrument = instruments.find(i=>i.id === proposal.instrumentId) ?? instruments[0];
  const runtimeContext = { ...context, instrument, now: preview ? simulation === "DEAD_POOL" ? "2026-09-04T18:00:00Z" : "2026-09-04T14:00:00Z" : now, slotsUsed: preview && simulation === "LIMIT" ? 2 : context.slotsUsed };
  const result = evaluateRisk(proposal, runtimeContext);
  const clock = strategyClock(runtimeContext.now);
  const shown = serverResult ?? result;
  const stale = Boolean(serverResult && !planId && !isRiskReportCurrent(serverResult,runtimeContext,observationId));
  const calc = shown.calculations;
  const feedback=proposalFeedback(proposal);
  function update<K extends keyof Proposal>(key: K, value: Proposal[K]) {
    setDirty(true);setProposal(p=>({...p,[key]:value})); setSubmitted(false); setEvaluationId(undefined); setServerResult(null); setError(""); setRequestKey(undefined);
  }
  function check() {
    setSubmitted(true); setError("");
    if (preview || !accountId || !observationId) return;
    setOperation("check"); setServerResult(null); setEvaluationId(undefined);
    startTransition(async () => {
      const response = await evaluatePlan({accountId,observationId,riskPlanId:context.plan.id,proposal});
      if (response.error) {setError(Object.keys(feedback).length?Object.values(feedback).join(" "):response.error);setServerResult(null);setEvaluationId(undefined);}
      if (response.result) setServerResult(response.result);
      if (response.evaluationId) setEvaluationId(response.evaluationId);
    });
  }
  async function lock() {
    if (!accountId || !observationId || preview) return;
    const key = requestKey ?? crypto.randomUUID(); setRequestKey(key); setOperation("lock");
    startTransition(async () => {
      setError("");
      const response = await lockPlan({ accountId, observationId, riskPlanId: context.plan.id, key, proposal });
      if (response.error) {setError(response.error);setServerResult(null);setEvaluationId(undefined);setSubmitted(false);}
      if (response.result) setServerResult(response.result);
      if (response.evaluationId) setEvaluationId(response.evaluationId);
      if (response.planId) setPlanId(response.planId);
    });
  }
  const blocked = shown.status === "TRADE_BLOCKED";
  function saveForAnalysis(){
    if(!accountId||!observationId||preview)return;
    const key=requestKey??crypto.randomUUID();setRequestKey(key);setOperation("save");setError("");
    startTransition(async()=>{
      const response=await saveSetup({accountId,observationId,riskPlanId:context.plan.id,key,proposal});
      if(response.error)setError(response.error);
      if(response.id){setDirty(false);router.push(`/analyze/${response.id}`);}
    });
  }
  return <>{unsavedDialog}
    <div className="page-heading"><div><div className="eyebrow">PRE-TRADE WORKSPACE</div><h1>Build a deliberate trade.</h1><p>Define the plan. Check the risk. Preserve the original.</p></div><span className="pill"><span className="dot"/>{preview ? "RISK ENGINE PREVIEW" : "MANUAL PLAN"}</span></div>
    {preview && <div className="notice preview-notice"><CircleAlert size={18}/><div><strong>Isolated example · no account data is saved</strong><p>Explore the risk rules using a fictional $10,000 USD account. Sign in to lock a real demo plan.</p></div><label className="scenario-label">Test scenario<select value={simulation} onChange={e=>{setSimulation(e.target.value);setSubmitted(true);}}><option value="ACTIVE">Active kill zone</option><option value="DEAD_POOL">Dead Pool</option><option value="LIMIT">Two slots reserved</option></select></label></div>}
    <div className="metrics-strip"><Metric label="RECORDED EQUITY" value={`$${Number(context.equity).toLocaleString("en-US",{minimumFractionDigits:2})}`} detail="USD · user-reported"/><Metric label="MAXIMUM RISK" value={`${Number(context.plan.maxRiskPercent).toFixed(2)}%`} detail={context.plan.version}/><Metric label="DAILY SLOTS RESERVED" value={`${runtimeContext.slotsUsed} / ${context.plan.maxDailyTrades}`} detail="Locked plans · not executions"/><Metric label="STRATEGY CLOCK" value={clock.time} detail={`${clock.session.replaceAll("_"," ")} · UTC−5`} danger={clock.session === "DEAD_POOL"}/></div>
    <div className="analysis-grid"><section className="panel"><div className="panel-heading"><h2><span className="step-number">01</span>Trade parameters</h2><span className="small muted">ICT V1.0</span></div>
      <form noValidate onSubmit={e=>{e.preventDefault();check();}} className="trade-form">
        <fieldset disabled={Boolean(planId) || pending}>
          <div className="form-grid"><Field label="Instrument"><select value={proposal.instrumentId} onChange={e=>update("instrumentId",e.target.value)}>{instruments.map(i=><option key={i.id} value={i.id}>{i.symbol} · {i.currency}</option>)}</select></Field><Field label="Direction"><select value={proposal.direction} onChange={e=>update("direction",e.target.value as Proposal["direction"])}><option value="LONG">Long</option><option value="SHORT">Short</option></select></Field></div>
          <Field label="Execution model"><select value={proposal.model} onChange={e=>update("model",e.target.value as Proposal["model"])}><option value="OB_FIRST_TOUCH">OB · first-touch mitigation</option><option value="OTE">OTE · predefined retracement</option></select></Field>
          <div className="form-grid three"><Field label="Entry price" hint={submitted?feedback.entry:undefined}><input aria-invalid={submitted&&Boolean(feedback.entry)} required inputMode="decimal" placeholder="1.10000" value={proposal.entry} onChange={e=>update("entry",e.target.value)}/></Field><Field label="Stop loss" hint={submitted?feedback.stop:undefined}><input aria-invalid={submitted&&Boolean(feedback.stop)} inputMode="decimal" placeholder="1.09800" value={proposal.stop ?? ""} onChange={e=>update("stop",e.target.value || null)}/></Field><Field label="Target price" hint={submitted?feedback.target:undefined}><input aria-invalid={submitted&&Boolean(feedback.target)} required inputMode="decimal" placeholder="1.10600" value={proposal.target} onChange={e=>update("target",e.target.value)}/></Field></div>
          <div className="form-grid"><Field label="Requested risk (%)" hint={submitted?feedback.riskPercent:undefined}><input aria-invalid={submitted&&Boolean(feedback.riskPercent)} required inputMode="decimal" value={proposal.riskPercent} onChange={e=>update("riskPercent",e.target.value)}/></Field><Field label="News environment" hint="User-reported · no calendar feed"><select value={proposal.news} onChange={e=>update("news",e.target.value as Proposal["news"])}><option value="UNKNOWN">Not verified</option><option value="CLEAR">Checked · no restriction</option><option value="RESTRICTED">Restricted news window</option></select></Field></div>
          <Field label="Pre-trade reasoning" hint="Record the context, liquidity event, entry rationale, target and invalidation. Claims remain user-reported."><textarea required rows={4} maxLength={5000} placeholder="What supports this setup, and what could disprove it?" value={proposal.narrative} onChange={e=>update("narrative",e.target.value)}/></Field>
          <div className="contract-box"><strong>Instrument specification</strong><span>{instrument.quantityUnit} · tick {instrument.tickSize} · ${instrument.tickValue}/tick per lot · size step {instrument.quantityStep}</span><label className="check-label"><input type="checkbox" checked={proposal.contractConfirmed} onChange={e=>update("contractConfirmed",e.target.checked)}/>I confirm these contract values match my demo broker.</label></div>
          <label className="check-label"><input type="checkbox" checked={proposal.contradiction} onChange={e=>update("contradiction",e.target.checked)}/>I have identified a contradiction with my strategy.</label>
          <Button type="submit" variant="outline"><ShieldCheck size={17}/>{pending && operation === "check" ? "Checking and saving…" : "Run risk check"}<ArrowRight size={16}/></Button>
        </fieldset>
      </form>
    </section><div className="assessment-column"><section className="panel result-panel"><div className="panel-heading"><h2><span className="step-number">02</span>Risk assessment</h2><span className="small muted">ENGINE 1.0</span></div>
      <div className={`decision ${stale ? "decision-pending" : submitted || serverResult ? blocked ? "decision-blocked" : "decision-approved" : "decision-pending"}`}><ShieldCheck size={26}/><div><small>{stale ? "SAVED REPORT · CONTEXT CHANGED" : serverResult ? "SAVED · SERVER-VERIFIED" : "DETERMINISTIC PREVIEW"}</small><h3>{stale ? "RECHECK REQUIRED" : submitted || serverResult ? blocked ? "TRADE BLOCKED" : "RISK APPROVED" : "READY TO CHECK"}</h3><p>{stale ? "The session or account context changed. Run a fresh risk check." : submitted || serverResult ? blocked ? "Resolve the blocking conditions below." : "Risk rules pass. Review the summary before locking." : "Complete the plan and confirm the contract."}</p></div></div>
      <div className="calculation-hero"><span>PLANNED REWARD / RISK</span><strong>{calc ? `${Number(calc.plannedRR).toFixed(2)}` : "—"}<small>R</small></strong><span>Minimum {Number(context.plan.minRR).toFixed(2)}R · {context.plan.rrPolicy.toLowerCase()} below threshold</span></div>
      <dl className="calculation-list"><div><dt>Risk budget</dt><dd>{calc ? `$${calc.budget}` : "—"}</dd></div><div><dt>Nominal stop risk</dt><dd>{calc ? `$${Number(calc.nominalRisk).toFixed(2)}` : "—"}</dd></div><div><dt>Position size</dt><dd>{calc ? `${calc.quantity} lots` : "—"}</dd></div><div><dt>Stop distance</dt><dd>{calc ? `${Number(calc.stopPips ?? calc.stopTicks).toFixed(1)} ${calc.stopPips ? "pips" : "ticks"}` : "—"}</dd></div></dl>
      {serverResult && <dl className="calculation-list"><div><dt>Requested risk</dt><dd>{serverResult.requestedRiskPercent}%</dd></div><div><dt>Target distance</dt><dd>{serverResult.targetDistance ?? "—"}</dd></div><div><dt>Daily risk reserved before check</dt><dd>USD {serverResult.snapshot.riskConsumed}</dd></div><div><dt>Slots before check</dt><dd>{serverResult.snapshot.slotsUsed} / {serverResult.snapshot.maximumDailyTrades}</dd></div><div><dt>Session eligible</dt><dd>{serverResult.sessionEligible ? "Yes" : "No"}</dd></div></dl>}
      {serverResult && <details className="padded"><summary>All rule results</summary>{serverResult.ruleResults.map(rule=><p key={rule.rule} className={rule.outcome === "BLOCK" ? "red" : rule.outcome === "PASS" ? "success" : "amber"}><strong>{rule.rule} · {rule.outcome}</strong><br/>{rule.message}</p>)}<p className="small muted">Saved check {evaluationId}<br/>{serverResult.evaluatedAt} · server time</p></details>}
      {(submitted || serverResult) && <div className="issue-list" aria-live="polite">{shown.issues.map(i=><div key={i.code} className={`issue ${i.severity === "BLOCK" ? "red" : "amber"}`}><CircleAlert size={15}/><span>{i.message}</span></div>)}</div>}
    </section><section className="panel lock-panel"><div className="panel-heading"><h2><span className="step-number">03</span>Preserve the plan</h2><LockKeyhole size={17}/></div><dl className="calculation-list"><div><dt>Trade</dt><dd>{instrument.symbol} · {proposal.direction}</dd></div><div><dt>Entry / SL / TP</dt><dd>{proposal.entry||"—"} / {proposal.stop||"—"} / {proposal.target||"—"}</dd></div><div><dt>Risk / planned RR</dt><dd>{proposal.riskPercent}% / {calc?Number(calc.plannedRR).toFixed(2)+"R":"—"}</dd></div><div><dt>Model / versions</dt><dd>{proposal.model.replaceAll("_"," ")}<br/>ICT V1.0 · {context.plan.version}</dd></div></dl><p>Entry, stop, target, reasoning and governing versions become immutable. Later notes are appended to the history.</p>
      {!planId && <Button className="full-width" disabled={preview||pending} onClick={saveForAnalysis}>{pending&&operation==="save"?"Saving proposal…":"Save proposal & add screenshots"}<ArrowRight size={16}/></Button>}
      {!planId && <p className="small muted">Saving preserves these proposed parameters and the attached strategy without reserving risk. Screenshots remain available when AI analysis is disabled.</p>}
      {planId ? <div className="notice success"><Check size={18}/><div>Original plan locked. Later changes are recorded as events.<Link href={`/journal/${planId}`}>Open plan and audit history →</Link></div></div> : <Button className="full-width" variant="outline" disabled={preview || pending || !serverResult || blocked || stale} onClick={lock}><LockKeyhole size={16}/>{pending && operation === "lock" ? "Rechecking and locking…" : "Lock original plan"}</Button>}
      {error && <p className="notice danger" role="alert">{error}</p>}
      <small>{preview ? <Link href="/login">Sign in to save a demo plan →</Link> : "Locking rechecks current limits on the server and reserves one daily slot."}</small>
    </section></div></div>
    <div className="evidence-footer"><span className="pill amber">SETUP · NOT EVALUATED</span><p>Chart evidence, MSS quality and entry validity have not been assessed. Risk approval alone does not validate a setup.</p></div>
  </>;
}
export function Metric({label,value,detail,danger=false}:{label:string;value:string;detail:string;danger?:boolean}) { return <div className="metric"><span>{label}</span><strong className={danger ? "red" : ""}>{value}</strong><small>{detail}</small></div>; }
