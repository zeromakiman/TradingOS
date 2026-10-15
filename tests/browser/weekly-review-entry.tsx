import {useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {WeeklyReviewPanel} from "@/components/weekly-review";
import {Shell} from "@/components/shell";
import type {WeeklyReviewPanelData} from "@/lib/weekly-review-data";
function Harness(){
 const [data,setData]=useState<WeeklyReviewPanelData|null>(null),[scenario,setScenario]=useState("ON"),[key,setKey]=useState(()=>crypto.randomUUID());
 useEffect(()=>{const load=()=>fetch("/state?"+new URLSearchParams({scenario,week:new URLSearchParams(location.search).get("week")??"2026-08-31"})).then(r=>r.json()).then(setData);void load();window.addEventListener("fixture-refresh",load);return()=>window.removeEventListener("fixture-refresh",load);},[scenario]);
 return <Shell active="Edge" preview accountId="20000000-0000-4000-8000-000000000001"><p className="notice">LOCAL SYNTHETIC WEEK · mock responses · no provider or production access</p><label className="field">Test scenario<select value={scenario} onChange={e=>{setScenario(e.target.value);setKey(crypto.randomUUID());}}>{["ON","OFF","UNAVAILABLE","BUDGET REACHED","EMPTY","SCOPE LIMIT","COMPLETED","FAILED","IN PROGRESS","INCOMPLETE","SUBMIT ERROR","SUBMIT FAILURE"].map(s=><option key={s}>{s}</option>)}</select></label><div className="page-heading"><div><p className="eyebrow">EDGE · OPTIONAL WEEKLY REFLECTION</p><h1>Review the week.</h1><p>Recorded process, bounded scope, preserved history.</p></div></div>{data&&<WeeklyReviewPanel key={scenario} data={data} requestKey={key}/>}</Shell>;
}
const container=document.getElementById("root");if(container)createRoot(container).render(<Harness/>);
