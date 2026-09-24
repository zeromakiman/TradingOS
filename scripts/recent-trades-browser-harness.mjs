// Real UI/form/action, synthetic services only; never loads credentials or contacts providers.
import {createServer} from "node:http";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
const {build}=createRequire(resolve(".local/ai-budget-tools/package.json"))("esbuild");
const out=resolve(".local/recent-browser");mkdirSync(out,{recursive:true});
const plugin=modules=>({name:"fixture",setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(modules,a.path)?{path:a.path,namespace:"fixture"}:undefined);b.onLoad({filter:/.*/,namespace:"fixture"},a=>({contents:modules[a.path],loader:"js",resolveDir:process.cwd()}));}});
await build({stdin:{contents:"export * from './tests/fixtures/recent-trades';export {recentSample,recentTradesContext} from './src/ai/recent-trades-context';export {operationFor} from './src/ai/operations';",resolveDir:process.cwd()},bundle:true,platform:"node",format:"esm",packages:"external",outfile:out+"/fixture.mjs",alias:{"@":resolve("src")}});
const {recentOutput,ids,makeSources,recentSample,recentTradesContext,operationFor}=await import(pathToFileURL(out+"/fixture.mjs"));
let scenario="ON",requested=20;const history=[],submissions=[];
const sampleFacts=(n,count=n)=>recentTradesContext(ids.account,n,makeSources(count).reverse(),new Date().toISOString());
function record(id,status="COMPLETED",n=requested,count=n){
 const now=new Date().toISOString(),facts=sampleFacts(n,count);
 return {id,facts,operation:operationFor("RECENT_TRADES_ANALYSIS"),created_at:now,deadline_at:status==="INCOMPLETE"?"2026-01-01T00:00Z":new Date(Date.now()+600000).toISOString(),result:["IN PROGRESS","INCOMPLETE"].includes(status)?null:{review_id:id,status,interpretation:status==="COMPLETED"?recentOutput:null,error_code:status==="FAILED"?"ACCOUNTING_UNCERTAIN":null,reservation_id:ids.image,created_at:now},accounting:{reservedMicros:924000,usage:status==="COMPLETED"?{reservation_id:ids.image,charged_micros:21000,disposition:"SETTLED"}:null}};
}
const save=()=>writeFileSync(out+"/verification.json",JSON.stringify({submissions,historyCount:history.length,providerCalls:0,productionTouched:false},null,2));save();
globalThis.__recentFixture={analyze:async(account,n,key)=>{
 if(scenario==="SUBMIT ERROR")throw new Error("Synthetic internal failure");
 if(account!==ids.account||n!==requested||!["ON","FEWER","COMPLETED","SUBMIT FAILURE"].includes(scenario))return {status:"BUDGET_REACHED",message:"The AI budget cannot cover the required request reservation."};
 if(history.some(x=>x.id===key))return {status:"RECORDED",message:"This request was already recorded. No additional provider request was made."};
 const count=scenario==="FEWER"?7:n;submissions.push({account,requested:n,actual:count,key});await new Promise(r=>setTimeout(r,2500));const failed=scenario==="SUBMIT FAILURE";history.unshift(record(key,failed?"FAILED":"COMPLETED",n,count));save();return {status:failed?"FAILED":"COMPLETED",message:failed?"Recent-trades analysis failed. The attempt and protected accounting remain in history.":"Recent-trades analysis saved. Trading records and deterministic calculations are unchanged."};
}};
await build({entryPoints:["src/app/recent-trades-actions.ts"],bundle:true,platform:"node",format:"esm",packages:"external",outfile:out+"/actions.mjs",plugins:[plugin({"next/cache":"export function revalidatePath(){}","next/navigation":"export function unstable_rethrow(){}","@/lib/recent-trades":"export async function analyzeRecentTrades(...args){return globalThis.__recentFixture.analyze(...args)}"})],alias:{"@":resolve("src")}});
const {requestRecentTrades}=await import(pathToFileURL(out+"/actions.mjs"));
await build({entryPoints:["tests/browser/recent-trades-entry.tsx"],bundle:true,platform:"browser",format:"esm",outfile:out+"/client.js",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},plugins:[plugin({"next/link":'import {createElement} from "react";export default function Link(props){return createElement("a",props)}',"next/navigation":"export function useRouter(){return {push(){},refresh(){}}}","@/app/actions":"export async function logout(){}","@/app/recent-trades-actions":"export async function requestRecentTrades(state,form){const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([...form])});const result=await r.json();window.dispatchEvent(new Event('fixture-refresh'));return result;}"})],alias:{"@":resolve("src")}});
const css=readFileSync("src/app/globals.css","utf8").replace(/^@import .*;\r?\n/gm,"");globalThis.fetch=()=>{throw new Error("External network forbidden in recent-trades harness")};
const server=createServer(async(req,res)=>{
 res.setHeader("Cache-Control","no-store");res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
 try{
  const url=new URL(req.url,"http://127.0.0.1:3120");
  if(url.pathname==="/client.js"){res.setHeader("Content-Type","text/javascript");res.end(readFileSync(out+"/client.js"));return;}
  if(url.pathname==="/style.css"){res.setHeader("Content-Type","text/css");res.end(css);return;}
  if(url.pathname==="/state"){
   scenario=url.searchParams.get("scenario")??"ON";requested=recentSample(url.searchParams.get("sample")??"20");
   const empty=scenario==="EMPTY",actual=empty?0:scenario==="FEWER"?7:requested;
   const status=scenario==="OFF"?"ACCOUNT_OFF":scenario==="UNAVAILABLE"?"DISABLED":scenario==="BUDGET REACHED"?"BUDGET_REACHED":"ENABLED";
   const message=status==="ACCOUNT_OFF"?"AI is OFF for this account. Enable it explicitly in Settings.":status==="DISABLED"?"AI analysis is currently disabled":status==="BUDGET_REACHED"?"The AI budget cannot cover the required request reservation. Review your limit and usage in Settings.":"AI available";
   const rows=["COMPLETED","FAILED","IN PROGRESS","INCOMPLETE"].includes(scenario)?[record(ids.review,scenario)]:history.filter(r=>r.facts.sample.requested===requested);
   res.setHeader("Content-Type","application/json");res.end(JSON.stringify({account:{id:ids.account,name:"Synthetic"},requested,eligibleCount:scenario==="FEWER"?7:empty?0:35,facts:sampleFacts(requested,actual),scopeError:scenario==="SCOPE LIMIT"?"This sample exceeds the 300-event analysis limit. Nothing was sent; no events were silently omitted.":null,availability:{status,message,deepEnabled:false},amount:924000,error:null,history:rows,page:0,hasOlder:false}));return;
  }
  if(url.pathname==="/action"&&req.method==="POST"){
   if(req.headers.origin!=="http://127.0.0.1:3120")throw new Error("Local origin required");let body="";for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error("Too large");}
   const form=new FormData();for(const [k,v] of JSON.parse(body))form.append(k,v);res.setHeader("Content-Type","application/json");res.end(JSON.stringify(await requestRecentTrades({},form)));return;
  }
  if(!["/","/edge/recent"].includes(url.pathname)){res.writeHead(404).end();return;}
  res.setHeader("Content-Type","text/html; charset=utf-8");res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trading OS · Local recent-trades test</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>');
 }catch{res.writeHead(400).end("Local synthetic request rejected");}
});
server.listen(3120,"127.0.0.1",()=>console.log("Recent-Trades Analysis http://127.0.0.1:3120/ (synthetic only)"));
