// Loopback-only browser harness: actual review component, ActionForm and Server Action; synthetic review service.
// No environment files, Supabase clients, credentials, provider calls or production data.
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const {build}=createRequire(resolve('.local/ai-budget-tools/package.json'))('esbuild');
const out=resolve('.local/trade-review-browser');mkdirSync(out,{recursive:true});
const plugin=modules=>({name:'fixture-modules',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(modules,a.path)?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:modules[a.path],loader:'js',resolveDir:process.cwd()}));}});
let scenario='ON',history=[];const submissions=[];
await build({stdin:{contents:"export * from './tests/fixtures/trade-review';export {tradeReviewContext} from './src/ai/trade-review-context';export {operationFor} from './src/ai/operations';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:`${out}/fixture.mjs`,alias:{'@':resolve('src')}});
const {plan,trade,strategy,risk,events,output,ids,tradeReviewContext,operationFor}=await import(pathToFileURL(`${out}/fixture.mjs`));
const facts=tradeReviewContext(plan,trade,strategy,risk,events,[]);
function record(id,status='COMPLETED') {const now=new Date().toISOString();return {id,facts,operation:operationFor('REVIEW_TRADE'),created_at:now,deadline_at:new Date(Date.now()+600000).toISOString(),result:status==='IN PROGRESS'||status==='INCOMPLETE'?null:{review_id:id,status,interpretation:status==='COMPLETED'?output:null,error_code:status==='FAILED'?'ACCOUNTING_UNCERTAIN':null,reservation_id:ids.image,created_at:now},accounting:{reservedMicros:792000,usage:status==='COMPLETED'?{reservation_id:ids.image,charged_micros:21000,disposition:'SETTLED'}:null}};}
globalThis.__reviewFixture={review:async(planId,key,evidence)=>{
 if(scenario==='SUBMIT ERROR')throw new Error('Synthetic server error');
 if(planId!==ids.plan||!['ON','COMPLETED','SUBMIT FAILURE'].includes(scenario))return {status:'BUDGET_REACHED',message:'The AI budget cannot cover the required request reservation.'};
 submissions.push({planId,key,evidence});await new Promise(r=>setTimeout(r,2500));
 if(!history.some(r=>r.id===key))history.unshift(record(key,scenario==='SUBMIT FAILURE'?'FAILED':'COMPLETED'));
 writeFileSync(`${out}/verification.json`,JSON.stringify({submissions,historyCount:history.length,providerCalls:0,productionTouched:false},null,2));
 return {status:scenario==='SUBMIT FAILURE'?'FAILED':'COMPLETED',message:scenario==='SUBMIT FAILURE'?'The review failed and the attempt was preserved in history.':'Trade review saved. Original records are unchanged.'};
}};
await build({entryPoints:['src/app/trade-review-actions.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:`${out}/actions.mjs`,plugins:[plugin({'next/cache':'export function revalidatePath(){}','next/navigation':'export function unstable_rethrow(){}','@/lib/trade-review':'export async function reviewTrade(...args){return globalThis.__reviewFixture.review(...args)}'})],alias:{'@':resolve('src')}});
const {requestTradeReview}=await import(pathToFileURL(`${out}/actions.mjs`));
await build({entryPoints:['tests/browser/trade-review-entry.tsx'],bundle:true,platform:'browser',format:'esm',outfile:`${out}/client.js`,jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[plugin({'next/link':'import {createElement} from "react"; export default function Link(props){return createElement("a",props)}','next/navigation':'export function useRouter(){return {push(){},refresh(){}}}','@/app/trade-review-actions':`export async function requestTradeReview(state,form){const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([...form])});const result=await response.json();window.dispatchEvent(new Event('fixture-refresh'));return result;}`})],alias:{'@':resolve('src')}});
const css=readFileSync('src/app/globals.css','utf8').replace(/^@import .*;\r?\n/gm,'');
globalThis.fetch=()=>{throw new Error('Network is forbidden in this isolated review service')};
const server=createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");try{
 const url=new URL(req.url,'http://127.0.0.1:3116');
 if(url.pathname==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(`${out}/client.js`));return;}
 if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
 if(url.pathname==='/state'){
  scenario=url.searchParams.get('scenario')??'ON';const status=scenario==='OFF'?'ACCOUNT_OFF':scenario==='UNAVAILABLE'?'DISABLED':scenario==='BUDGET REACHED'?'BUDGET_REACHED':'ENABLED';
  const message=status==='ACCOUNT_OFF'?'AI is OFF for this account. Enable it explicitly in Settings.':status==='DISABLED'?'AI analysis is currently disabled':status==='BUDGET_REACHED'?'The AI budget cannot cover the required request reservation. Review your limit and usage in Settings.':'AI available';
  const fixture=record(ids.review,scenario);if(scenario==='INCOMPLETE')fixture.deadline_at='2026-01-01T00:00Z';
  const rows=['COMPLETED','FAILED','IN PROGRESS','INCOMPLETE'].includes(scenario)?[fixture]:history;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({availability:{status,message,deepEnabled:false},amount:792000,closed:scenario!=='OPEN TRADE',error:null,evidence:[{id:ids.image,role:'H1',label:'Synthetic recorded setup.png'}],history:rows,page:0,hasOlder:false}));return;
 }
 if(url.pathname==='/action'&&req.method==='POST'){
  if(req.headers.origin!=='http://127.0.0.1:3116')throw new Error('Local origin required');let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Too large');}
  const form=new FormData();for(const [k,v] of JSON.parse(body))form.append(k,v);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await requestTradeReview({},form)));return;
 }
 if(url.pathname!=='/'){res.writeHead(404).end();return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trading OS · Local trade review test</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>');
 }catch{res.writeHead(400).end('Local fixture rejected');}});
server.listen(3116,'127.0.0.1',()=>console.log('Trade review browser harness: http://127.0.0.1:3116/ (synthetic only)'));
