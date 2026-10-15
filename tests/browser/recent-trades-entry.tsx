import {useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {RecentTradesPanel} from "@/components/recent-trades";
import {Shell} from "@/components/shell";
import type {RecentTradesPanelData} from "@/lib/recent-trades-data";
function Harness(){
 const [data,setData]=useState<RecentTradesPanelData|null>(null),[scenario,setScenario]=useState("ON"),[key,setKey]=useState(()=>crypto.randomUUID());
 useEffect(()=>{const load=()=>fetch("/state?"+new URLSearchParams({scenario,sample:new URLSearchParams(location.search).get("sample")??"20"})).then(r=>r.json()).then(setData);void load();window.addEventListener("fixture-refresh",load);return()=>window.removeEventListener("fixture-refresh",load);},[scenario]);
 return <Shell active="Edge" preview accountId="20000000-0000-4000-8000-000000000001"><p className="notice">LOCAL SYNTHETIC SAMPLE · mock responses · no provider or production access</p><label className="field">Test scenario<select value={scenario} onChange={e=>{setScenario(e.target.value);setKey(crypto.randomUUID());}}>{["ON","FEWER","OFF","UNAVAILABLE","BUDGET REACHED","EMPTY","SCOPE LIMIT","COMPLETED","FAILED","IN PROGRESS","INCOMPLETE","SUBMIT ERROR","SUBMIT FAILURE"].map(s=><option key={s}>{s}</option>)}</select></label><div className="page-heading"><div><p className="eyebrow">EDGE · OPTIONAL SAMPLE ANALYSIS</p><h1>Analyze recent trades.</h1><p>Recurring patterns across a precise sample, with preserved history.</p></div></div>{data&&<RecentTradesPanel key={scenario} data={data} requestKey={key}/>}</Shell>;
}
const container=document.getElementById("root");if(container)createRoot(container).render(<Harness/>);
