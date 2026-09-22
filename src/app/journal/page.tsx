import Link from "next/link";
import { SetupJournal } from "@/components/setup-journal";
import { Shell } from "@/components/shell";
import { AccountSetup } from "@/components/account-setup";
import { Field } from "@/components/forms";
import { loadJournalPage } from "@/lib/journal-data";
import { formatR, journalFilters, journalQuery, utcTime } from "@/domain/ux";
import { strategyClock } from "@/domain/session";
import { rTone } from "@/components/numeric";
export const dynamic="force-dynamic";
export default async function JournalPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const supplied=await searchParams,raw=Object.fromEntries(Object.entries(supplied).filter((e):e is [string,string]=>typeof e[1]==="string")),f=journalFilters(raw),{account,accounts,rows,count,plannedRR}=await loadJournalPage(raw.account,f);
 const active=Boolean(f.status||f.outcome||f.model||f.from||f.to||f.q||f.strategy);
 const select=(name:"status"|"outcome"|"model",label:string,values:string[])=><Field label={label}><select name={name} defaultValue={f[name]??""}><option value="">All</option>{values.map(s=><option key={s} value={s}>{s.replaceAll("_"," ")}</option>)}</select></Field>;
 type Record=(typeof rows)[number];
 const days:{day:string;rows:Record[]}[]=[];
 for(const t of rows){const day=strategyClock(t.locked_at).day,last=days.at(-1);if(last?.day===day)last.rows.push(t);else days.push({day,rows:[t]});}
 return <Shell active="Journal" accountId={account?.id}><div className="page-heading"><div><div className="eyebrow">JOURNAL · EXECUTION & HISTORY</div><h1>Your decision record.</h1><p>Review the plan, record what happened, and learn from completed trades.</p></div>{account&&<Link className="button button-outline" href={`/edge?account=${account.id}`}>Open EDGE →</Link>}</div>{!account?<AccountSetup/>:<div className="stack">
 <details className="panel padded" open={active}><summary>Search & filter trades · {account.name}</summary><form className="form-stack" action="/journal"><div className="edge-filters"><Field label="Account"><select name="account" defaultValue={account.id}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Search instrument or full trade ID"><input name="q" defaultValue={f.q} maxLength={80} placeholder="EURUSD or trade ID" type="search"/></Field>{select("status","Trade status",["LOCKED","TAKEN","CLOSED","SKIPPED","CANCELLED"])}{select("outcome","Outcome",["WIN","LOSS","BREAKEVEN"])}{select("model","Entry model",["OB_FIRST_TOUCH","OTE"])}<Field label="Strategy version"><input name="strategy" defaultValue={f.strategy} placeholder="e.g. ICT V1.0" maxLength={80}/></Field><Field label="Locked from · UTC−5"><input name="from" type="date" defaultValue={f.from}/></Field><Field label="Locked through · UTC−5"><input name="to" type="date" defaultValue={f.to}/></Field></div><div className="row"><button className="button button-outline" type="submit">Apply filters</button>{active&&<Link href={`/journal?account=${account.id}`}>Clear filters</Link>}</div></form></details>
 {f.from&&f.to&&f.from>f.to?<p className="notice danger" role="alert">The start date must be on or before the end date.</p>:null}
 <section className="panel"><div className="panel-heading"><h2>{count} matching {count===1?"trade":"trades"}</h2><Link href={`/analyze?account=${account.id}`}>New trade →</Link></div>{rows.length?<ol className="record-list">{days.map(group=><li key={group.day}><div className="record-day"><span>{group.day} · UTC−5</span></div><ol className="record-list">{group.rows.map(t=>{const result=formatR(t.realized_r);return <li key={t.id}><Link className="record" href={`/journal/${t.id}?returnTo=${encodeURIComponent(`/journal?${journalQuery(account.id,f)}`)}`}>
  <span className="record-id"><strong>{t.instrument} · {t.direction}</strong><small>Locked {utcTime(t.locked_at)}</small></span>
  <span className="record-method">{t.entry_model.replaceAll("_"," ")}<small>{t.strategy_version}</small></span>
  <span className="record-status"><span className={`status-pill s-${t.status}`}>{t.status}</span>{t.status==="TAKEN"&&!t.execution_id&&<small className="record-flag">Actual fill missing</small>}</span>
  <span className="record-plan">{plannedRR.has(t.id)?`${Number(plannedRR.get(t.id)).toFixed(2)}R`:"—"} planned<small>${Number(t.initial_risk).toFixed(2)} · {Number(t.risk_percent).toFixed(2)}%</small></span>
  <span className={`record-result ${rTone(result)}`}>{result}<small>{t.outcome??"Not closed"}</small></span>
 </Link></li>;})}</ol></li>)}</ol>:<div className="empty-state"><h2>{active?"No trades match these filters.":"Your Journal starts with a locked plan."}</h2><p>{active?"Clear or broaden the filters to find your records.":"Create a proposal, check its risk, and lock it when the rules pass."}</p><Link className="button button-outline" href={active?`/journal?account=${account.id}`:`/analyze?account=${account.id}`}>{active?"Clear filters":"Create a trade plan"}</Link></div>}</section>
 {(count>50||f.page>0)&&<nav className="row" aria-label="Journal pages">{f.page>0&&<Link href={`/journal?${journalQuery(account.id,f,f.page-1)}`}>← Newer</Link>}<span>Page {f.page+1} · 50 per page</span>{count>(f.page+1)*50&&<Link href={`/journal?${journalQuery(account.id,f,f.page+1)}`}>Older →</Link>}</nav>}
 {!active&&f.page===0&&<SetupJournal accountId={account.id} page={/^\d{1,5}$/.test(raw.proposals??"")?Number(raw.proposals):0}/>}</div>}</Shell>;
}
