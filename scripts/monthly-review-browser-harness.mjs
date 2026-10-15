// Actual Shell/panel/form/action; synthetic service only. Never loads credentials or production.
import {createServer} from "node:http";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
const {build}=createRequire(resolve(".local/ai-budget-tools/package.json"))("esbuild");
const out=resolve(".local/monthly-browser");mkdirSync(out,{recursive:true});
const plugin=modules=>({name:"fixture",setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(modules,a.path)?{path:a.path,namespace:"fixture"}:undefined);b.onLoad({filter:/.*/,namespace:"fixture"},a=>({contents:modules[a.path],loader:"js",resolveDir:process.cwd()}));}});
await build({stdin:{contents:"export * from './tests/fixtures/monthly-review';export {monthlyPeriod,previousCompletedMonth} from './src/ai/monthly-period';export {monthlyReviewContext} from './src/ai/monthly-review-context';export {operationFor} from './src/ai/operations';",resolveDir:process.cwd()},bundle:true,platform:"node",format:"esm",packages:"external",outfile:out+"/fixture.mjs",alias:{"@":resolve("src")}});
const {facts,monthlyOutput,ids,month,monthSources,monthlyPeriod,previousCompletedMonth,monthlyReviewContext,operationFor}=await import(pathToFileURL(out+"/fixture.mjs"));
let scenario="ON";const history=[],submissions=[];
function record(id,status="COMPLETED"){
 const now=new Date().toISOString();
 return {id,facts:scenario==="SUMMARY"?monthlyReviewContext(ids.account,month,monthSources(60)):facts,operation:operationFor("MONTHLY_REVIEW"),created_at:now,deadline_at:status==="INCOMPLETE"?"2026-01-01T00:00Z":new Date(Date.now()+600000).toISOString(),result:["IN PROGRESS","INCOMPLETE"].includes(status)?null:{review_id:id,status,interpretation:status==="COMPLETED"?monthlyOutput:null,error_code:status==="FAILED"?"ACCOUNTING_UNCERTAIN":null,reservation_id:ids.image,created_at:now},accounting:{reservedMicros:924000,usage:status==="COMPLETED"?{reservation_id:ids.image,charged_micros:21000,disposition:"SETTLED"}:null}};
}
const save=()=>writeFileSync(out+"/verification.json",JSON.stringify({submissions,historyCount:history.length,providerCalls:0,productionTouched:false},null,2));save();
globalThis.__monthlyFixture={review:async(account,day,key)=>{
 if(scenario==="SUBMIT ERROR")throw new Error("Synthetic internal failure");
 if(account!==ids.account||day!==month||!["ON","SUMMARY","COMPLETED","SUBMIT FAILURE"].includes(scenario))return {status:"BUDGET_REACHED",message:"The AI budget cannot cover the required request reservation."};
 if(history.some(x=>x.id===key))return {status:"RECORDED",message:"This request was already recorded. No additional provider request was made."};
 submissions.push({account,day,key});await new Promise(r=>setTimeout(r,2500));const failed=scenario==="SUBMIT FAILURE";history.unshift(record(key,failed?"FAILED":"COMPLETED"));save();return {status:failed?"FAILED":"COMPLETED",message:failed?"Monthly review failed. The attempt and protected accounting remain in history.":"Monthly review saved. Trading records and deterministic calculations are unchanged."};
}};
await build({entryPoints:["src/app/monthly-review-actions.ts"],bundle:true,platform:"node",format:"esm",packages:"external",outfile:out+"/actions.mjs",plugins:[plugin({"next/cache":"export function revalidatePath(){}","next/navigation":"export function unstable_rethrow(){}","@/lib/monthly-review":"export async function reviewMonth(...args){return globalThis.__monthlyFixture.review(...args)}"})],alias:{"@":resolve("src")}});
const {requestMonthlyReview}=await import(pathToFileURL(out+"/actions.mjs"));
await build({entryPoints:["tests/browser/monthly-review-entry.tsx"],bundle:true,platform:"browser",format:"esm",outfile:out+"/client.js",jsx:"automatic",define:{"process.env.NODE_ENV":'"development"'},plugins:[plugin({"next/link":'import {createElement} from "react";export default function Link(props){return createElement("a",props)}',"next/navigation":"export function useRouter(){return {push(){},refresh(){}}}","@/app/actions":"export async function logout(){}","@/app/monthly-review-actions":"export async function requestMonthlyReview(state,form){const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([...form])});const result=await r.json();window.dispatchEvent(new Event('fixture-refresh'));return result;}"})],alias:{"@":resolve("src")}});
const css=readFileSync("src/app/globals.css","utf8").replace(/^@import .*;\r?\n/gm,"");globalThis.fetch=()=>{throw new Error("External network forbidden in monthly harness")};
const server=createServer(async(req,res)=>{
 res.setHeader("Cache-Control","no-store");res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
 try{
  const url=new URL(req.url,"http://127.0.0.1:3121");
  if(url.pathname==="/client.js"){res.setHeader("Content-Type","text/javascript");res.end(readFileSync(out+"/client.js"));return;}
  if(url.pathname==="/style.css"){res.setHeader("Content-Type","text/css");res.end(css);return;}
  if(url.pathname==="/state"){
   scenario=url.searchParams.get("scenario")??"ON";const period=monthlyPeriod(url.searchParams.get("month")??month),empty=scenario==="EMPTY"||period.month!==month;
   const status=scenario==="OFF"?"ACCOUNT_OFF":scenario==="UNAVAILABLE"?"DISABLED":scenario==="BUDGET REACHED"?"BUDGET_REACHED":"ENABLED";
   const message=status==="ACCOUNT_OFF"?"AI is OFF for this account. Enable it explicitly in Settings.":status==="DISABLED"?"AI analysis is currently disabled":status==="BUDGET_REACHED"?"The AI budget cannot cover the required request reservation. Review your limit and usage in Settings.":"AI available";
   const rows=empty?[]:["COMPLETED","FAILED","IN PROGRESS","INCOMPLETE"].includes(scenario)?[record(ids.review,scenario)]:history;
   res.setHeader("Content-Type","application/json");res.end(JSON.stringify({account:{id:ids.account,name:"Synthetic"},period,maxMonth:previousCompletedMonth().month,facts:empty?{...facts,period,trades:[],sample:{count:0,tradeIds:[],label:"NO DATA",caveat:"Small sample: no completed trades."},edge:{...facts.edge,completed:0,netR:0,expectancy:null}}:scenario==="SUMMARY"?monthlyReviewContext(ids.account,month,monthSources(60)):facts,scopeError:scenario==="SCOPE LIMIT"?"This month exceeds the 120-trade review limit. Nothing was sent; no trades were silently omitted.":null,availability:{status,message,deepEnabled:false},amount:924000,error:null,history:rows,page:0,hasOlder:false}));return;
  }
  if(url.pathname==="/action"&&req.method==="POST"){
   if(req.headers.origin!=="http://127.0.0.1:3121")throw new Error("Local origin required");
   let body="";for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error("Too large");}
   const form=new FormData();for(const [k,v] of JSON.parse(body))form.append(k,v);res.setHeader("Content-Type","application/json");res.end(JSON.stringify(await requestMonthlyReview({},form)));return;
  }
  if(!["/","/edge/monthly"].includes(url.pathname)){res.writeHead(404).end();return;}
  res.setHeader("Content-Type","text/html; charset=utf-8");res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trading OS · Local monthly review test</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>');
 }catch{res.writeHead(400).end("Local synthetic request rejected");}
});
server.listen(3121,"127.0.0.1",()=>console.log("Monthly Review browser harness http://127.0.0.1:3121/ (synthetic only)"));
