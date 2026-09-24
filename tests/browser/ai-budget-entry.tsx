import {useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {AiSettings} from "@/components/ai-settings";
import type {loadAiBudget} from "@/lib/ai-budget";
type Payload={accountId:string;data:Awaited<ReturnType<typeof loadAiBudget>>};
function Harness(){
 const [payload,setPayload]=useState<Payload|null>(null),[scenario,setScenario]=useState("available");
 useEffect(()=>{const load=()=>fetch(`/state?scenario=${scenario}`).then(r=>r.json()).then(setPayload);void load();window.addEventListener("fixture-refresh",load);return()=>window.removeEventListener("fixture-refresh",load);},[scenario]);
 return <main id="main-content" style={{maxWidth:1200,margin:"auto",padding:24}}><p className="notice">LOCAL TEST HARNESS · synthetic account · no provider access · simulated deployment availability</p><label className="field">Test scenario<select value={scenario} onChange={e=>setScenario(e.target.value)}><option value="available">Available (mock configuration)</option><option value="disabled">Global AI disabled</option><option value="pending">Used and reserved fixture</option><option value="warning50">50% usage fixture</option><option value="warning95">95% usage fixture</option><option value="warning">80% usage fixture</option><option value="reached">Budget reached fixture</option><option value="uncertain">Accounting uncertainty fixture</option></select></label><h1>Settings · AI acceptance</h1>{payload&&<AiSettings key={`${scenario}-${payload.data.snapshot?.enabled}-${payload.data.snapshot?.budgetCents}`} {...payload}/>}</main>;
}
const container=document.getElementById("root");if(container)createRoot(container).render(<Harness/>);
