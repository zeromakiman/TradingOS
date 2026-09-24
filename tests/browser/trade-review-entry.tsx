import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TradeAiReview} from '@/components/trade-ai-review';
import type {TradeReviewPanelData} from '@/lib/trade-review-data';
function Harness(){
 const [data,setData]=useState<TradeReviewPanelData|null>(null),[scenario,setScenario]=useState('ON');
 useEffect(()=>{const load=()=>fetch(`/state?scenario=${scenario}`).then(r=>r.json()).then(setData);void load();window.addEventListener('fixture-refresh',load);return()=>window.removeEventListener('fixture-refresh',load);},[scenario]);
 return <main id="main-content" style={{maxWidth:1200,margin:'auto',padding:24}}><p className="notice">LOCAL SYNTHETIC TRADE · mock responses · no provider or production access</p><label className="field">Test scenario<select value={scenario} onChange={e=>setScenario(e.target.value)}>{['ON','OFF','UNAVAILABLE','BUDGET REACHED','OPEN TRADE','COMPLETED','FAILED','IN PROGRESS','INCOMPLETE','SUBMIT ERROR','SUBMIT FAILURE'].map(s=><option key={s}>{s}</option>)}</select></label><h1>EURUSD · Trade Detail</h1>{data&&<TradeAiReview key={scenario} planId="30000000-0000-4000-8000-000000000001" data={data} requestKey="40000000-0000-4000-8000-000000000001"/>}</main>;
}
const container=document.getElementById('root');if(container)createRoot(container).render(<Harness/>);
