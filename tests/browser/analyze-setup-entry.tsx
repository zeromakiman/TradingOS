import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AnalyzeSetupPanel} from '@/components/analyze-setup';
import type {AnalyzeSetupPanelData} from '@/lib/analyze-setup-data';
function Harness(){
 const [data,setData]=useState<AnalyzeSetupPanelData|null>(null),[scenario,setScenario]=useState('ON'),[requestKey,setRequestKey]=useState(()=>crypto.randomUUID());
 useEffect(()=>{const load=()=>fetch(`/state?scenario=${encodeURIComponent(scenario)}`).then(r=>r.json()).then(setData);void load();window.addEventListener('fixture-refresh',load);return()=>window.removeEventListener('fixture-refresh',load);},[scenario]);
 return <main id="main-content" style={{maxWidth:1200,margin:'auto',padding:24}}><p className="notice">LOCAL SYNTHETIC PROPOSAL · mock responses · no provider or production access</p><label className="field">Test scenario<select value={scenario} onChange={e=>{setScenario(e.target.value);setRequestKey(crypto.randomUUID());}}>{['ON','OFF','UNAVAILABLE','BUDGET REACHED','LOCKED','COMPLETED','FAILED','IN PROGRESS','INCOMPLETE','SUBMIT ERROR','SUBMIT FAILURE'].map(s=><option key={s}>{s}</option>)}</select></label><h1>EURUSD · Analyze · saved proposal</h1>{data&&<AnalyzeSetupPanel key={scenario} proposalId="30000000-0000-4000-8000-000000000001" data={data} requestKey={requestKey}/>}</main>;
}
const container=document.getElementById('root');if(container)createRoot(container).render(<Harness/>);
