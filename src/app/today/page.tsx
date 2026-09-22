import { loadTodayActivity } from "@/lib/today-data";
import { dailyStatus, formatR } from "@/domain/ux";
import Link from "next/link";
import { ArrowRight, CircleAlert } from "lucide-react";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/status-banner";
import { SessionRibbon } from "@/components/session-ribbon";
import { rTone } from "@/components/numeric";
import { AccountSetup } from "@/components/account-setup";
import { ActionForm, Field } from "@/components/forms";
import { saveContext } from "@/app/actions";
import { loadWorkspace } from "@/lib/data";
import { strategyClock } from "@/domain/session";
export const dynamic = "force-dynamic";
export default async function TodayPage({searchParams}:{searchParams:Promise<{account?:string}>}) {
  const {account:accountId} = await searchParams;
  const state = await loadWorkspace(accountId), c = state.current;
  if (!c) return <Shell active="Today"><div className="page-heading"><div className="eyebrow">START YOUR FORWARD TEST</div></div><AccountSetup/></Shell>;
  const clock=strategyClock(c.context.now),activity=await loadTodayActivity(c.account.id,clock.day),next=activity.active.find(t=>t.execution_id)||activity.active[0],status=dailyStatus(c.context,next?.status??null),blocked=status.reasons.length>0;
  const todayR=formatR(activity.result);
  return <Shell active="Today" accountId={c.account.id}><div className="page-heading"><div><div className="eyebrow">{clock.day} · FIXED UTC−5</div><h1>{c.account.name}</h1><p>USD demo account · manual observation</p></div><Button asChild><Link href={`/analyze?account=${c.account.id}`}>New trade<ArrowRight size={16}/></Link></Button></div>
  {state.accounts.length > 1 && <form action="/today" className="row" style={{marginBottom:20}}><Field label="Active account"><select name="account" defaultValue={c.account.id}>{state.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Button type="submit" variant="outline">Switch account</Button></form>}
  <StatusBanner
    label={status.label}
    reasons={status.reasons}
    clock={`${clock.time} UTC−5 · ${clock.session.replaceAll("_"," ")}`}
    note={blocked?"You can still prepare proposals and manage existing trades.":"Each new plan requires a current risk check before locking."}
    readout={[
      {label:"SLOTS LEFT",value:`${status.slots} / ${c.riskPlan.maxDailyTrades}`,tone:status.slots===0?"red":undefined},
      {label:"RISK / TRADE",value:`${Number(c.riskPlan.maxRiskPercent).toFixed(2)}%`},
      {label:"TODAY",value:todayR,tone:rTone(todayR)}
    ]}
    action={next&&<Button asChild><Link href={`/journal/${next.id}`}>{next.execution_id?"Manage active trade":"Continue active plan"}<ArrowRight size={16}/></Link></Button>}/>
  <SessionRibbon now={c.context.now}/>
  <div className="context-strip">
    <span>Recorded equity <b>${Number(c.observation.equity).toLocaleString("en-US",{minimumFractionDigits:2})}</b></span>
    <span>Nominal risk reserved <b>${Number(c.context.riskConsumed).toFixed(2)}</b></span>
    <span>Locked plans today <b>{c.context.slotsUsed}</b></span>
    <span>Actual entries today <b>{activity.taken}</b></span>
    <span>Completed today <b>{activity.closed}</b></span>
    <span>Strategy <b>{c.strategy.version}</b></span>
    <span>Risk plan <b>{c.riskPlan.version}</b></span>
  </div>
  <section className="panel padded" style={{marginBottom:24}}><h2>Continue your work</h2>{activity.active.length?<div className="record-grid">{activity.active.map(t=><Link className="chart-card" key={t.id} href={`/journal/${t.id}`}><strong>{t.instrument} · {t.direction}</strong><p>{t.status}{t.status==="TAKEN"&&!t.execution_id?" · actual fill needed":""}</p><span>Manage trade →</span></Link>)}</div>:<p>No active trades or locked plans. Start with a new trade proposal.</p>}<Link href={`/journal?account=${c.account.id}`}>View all records →</Link></section>
  <div className="content-grid"><section className="panel"><div className="panel-heading"><h2>Pre-market context</h2><span className="small muted">USER-REPORTED</span></div><div className="padded"><ActionForm action={saveContext} guardUnsaved label="Save context revision"><input type="hidden" name="accountId" value={c.account.id}/><Field label="Today’s plan" hint="Daily/HTF narrative · key liquidity levels · preferred and alternative scenarios · invalidation · allowed setups · what to avoid"><textarea name="narrative" rows={12} maxLength={20000} defaultValue={c.narrative} placeholder="What does the higher-timeframe context allow me to look for today?"/></Field></ActionForm></div></section><div className="stack"><section className="panel"><div className="panel-heading"><h2>Risk boundaries</h2><span className="small muted">{c.riskPlan.version}</span></div><dl className="data-list padded"><div><dt>Strategy</dt><dd>{c.strategy.version}</dd></div><div><dt>Minimum planned RR</dt><dd>{Number(c.riskPlan.minRR).toFixed(2)}R · {c.riskPlan.rrPolicy}</dd></div><div><dt>Daily monetary risk cap</dt><dd className={c.riskPlan.dailyRiskCap?undefined:"amber"}>{c.riskPlan.dailyRiskCap ?? "Unconfigured"}</dd></div><div><dt>Daily loss cap</dt><dd className={c.riskPlan.dailyLossCap?undefined:"amber"}>{c.riskPlan.dailyLossCap ?? "Unconfigured"}</dd></div><div><dt>News restriction policy</dt><dd>{c.riskPlan.newsPolicy}</dd></div><div><dt>Account observation</dt><dd>{new Date(c.observation.recorded_at).toISOString().replace("T"," ").slice(0,16)} UTC</dd></div></dl>{(!c.riskPlan.dailyRiskCap||!c.riskPlan.dailyLossCap)&&<div className="padded" style={{paddingTop:0}}><Link href={`/settings?account=${c.account.id}`}>Configure the daily caps in Settings →</Link></div>}</section><section className="panel padded"><h2><CircleAlert size={17} className="amber"/>Economic events · not verified</h2><p style={{marginTop:12,fontSize:14}}>No calendar feed is connected. Check economic events independently and record the news context in each proposed plan.</p></section></div></div></Shell>;
}
