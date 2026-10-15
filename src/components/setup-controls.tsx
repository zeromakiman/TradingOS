// biome-ignore-all lint/performance/noImgElement: Blob previews stay local and never pass through an image optimization cache.
"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setupCommand } from "@/app/setup-actions";
import { Button } from "./ui/button";
import { Field } from "./forms";
import type { AiAvailability } from "@/ai/availability";
const roles=["DAILY","H4","H1","M30","M15","M5","M3","OTHER"];
export function SetupControls({id,activeCount,running,locked,ai}:{id:string;activeCount:number;running:boolean;locked:boolean;ai:AiAvailability}){
 const router=useRouter(),[busy,start]=useTransition(),[analyzing,setAnalyzing]=useState(false),[uploading,setUploading]=useState(false),[message,setMessage]=useState(""),[reason,setReason]=useState(""),[mode,setMode]=useState("NORMAL"),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<string|null>(null);
 useEffect(()=>{if(!file){setPreview(null);return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
 useEffect(()=>{if(ai.status!=="ENABLED"||(!running&&!analyzing))return;const timer=setInterval(()=>router.refresh(),8000);return()=>clearInterval(timer);},[running,analyzing,router,ai.status]);
 const pending=busy||analyzing;
 const aiPending=pending||(ai.status==="ENABLED"&&running);
 async function command(action:"CHECK"|"LOCK"|"TAKEN"|"SKIPPED"){
  start(async()=>{try{const result=await setupCommand({id,command:action,reason});setMessage(result.error??result.success??"");router.refresh();}catch{setMessage("The command failed. Refresh and check the saved history.");}});
 }
 async function analyze(){
  if(ai.status!=="ENABLED")return;
  setAnalyzing(true);setMessage("Analysis started. You may refresh; the saved run will remain visible.");
  try{const response=await fetch(`/api/setups/${id}/analyze`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({evaluationId:crypto.randomUUID(),mode})});const result=await response.json();setMessage(result.error??result.message??"Review finished. See the result and history below.");}catch{setMessage("Connection interrupted. Check the saved run before starting another review.");}finally{setAnalyzing(false);router.refresh();}
 }
 return <div className="stack">
  <section className="panel padded"><h2>Add chart evidence</h2><p>PNG, JPEG or WEBP · up to 4 MB each · 8 active charts · still images only. Roles describe the supplied image; they do not create missing evidence.</p>
   <form className="form-stack" onSubmit={event=>{event.preventDefault();const element=event.currentTarget,form=new FormData(element);setUploading(true);start(async()=>{try{const response=await fetch(`/api/setups/${id}/screenshots`,{method:"POST",body:form});const result=await response.json();setMessage(result.error??"Screenshot saved.");if(response.ok){element.reset();setFile(null);router.refresh();}}catch{setMessage("Upload failed. Please try again.");}finally{setUploading(false);}});}}>
    <Field label="Chart timeframe"><select name="role" defaultValue="M5">{roles.map(role=><option key={role}>{role}</option>)}</select></Field>
    <Field label="Chart screenshot"><input type="file" name="file" accept="image/png,image/jpeg,image/webp" required onChange={e=>setFile(e.target.files?.[0]??null)}/></Field>
    {preview&&<img className="chart-preview" src={preview} alt="Selected chart preview"/>}
    <Button disabled={pending||activeCount>=8||!file} type="submit">{uploading?"Uploading…":"Upload screenshot"}</Button>
   </form>
  </section>
  <section className="panel padded"><h2>Evaluate the setup</h2>{ai.status==="ENABLED"&&<p>Each review creates a permanent record. Deep Review adds an independent challenge.</p>}
   {ai.status!=="ENABLED"&&<p className={ai.status==="DISABLED"?"notice":"notice amber"} role="status">{ai.message}</p>}
   <Field label="Review mode"><select value={mode} onChange={e=>setMode(e.target.value)} disabled={aiPending||ai.status!=="ENABLED"}><option value="NORMAL">Normal · one evaluation</option>{ai.deepEnabled&&<option value="DEEP">Deep Review · three evaluations</option>}</select></Field>
   <Button className="full-width" disabled={aiPending||!activeCount||ai.status!=="ENABLED"} onClick={analyze}>{ai.status==="ENABLED"&&(running||analyzing)?"Analyzing…":"Analyze setup"}</Button>
  </section>
  <section className="panel padded"><h2>Risk and human decision</h2><p>AI and risk decisions stay separate. Taking a blocked setup records a manual override. Recording a decision does not place an order or reserve risk.</p>
   {!locked&&<div className="row"><Button variant="outline" disabled={pending} onClick={()=>command("CHECK")}>Recheck risk</Button><Button disabled={pending} onClick={()=>command("LOCK")}>Recheck & lock plan</Button></div>}
   <Field label="Decision reason (optional)"><textarea value={reason} maxLength={5000} onChange={e=>setReason(e.target.value)} rows={3}/></Field>
   <div className="row"><Button variant="outline" disabled={pending} onClick={()=>command("SKIPPED")}>Record skipped</Button><Button disabled={pending} onClick={()=>command("TAKEN")}>Record taken</Button></div>
  </section>
  {message&&<p className="notice" role="status">{message}</p>}
 </div>;
}
export function RemoveScreenshot({id}:{id:string}){
 const router=useRouter(),[busy,start]=useTransition(),[error,setError]=useState("");
 return <><Button variant="outline" disabled={busy} onClick={()=>start(async()=>{try{const r=await setupCommand({id,command:"REMOVE"});setError(r.error??"");router.refresh();}catch{setError("Could not remove screenshot.");}})}>Remove from next review</Button>{error&&<p role="alert">{error}</p>}</>;
}
