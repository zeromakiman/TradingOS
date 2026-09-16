"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
export function shouldGuardLink(href:string,current:string){
 const next=new URL(href,current),here=new URL(current);
 return next.origin!==here.origin||next.pathname!==here.pathname||next.search!==here.search;
}
export function useUnsavedChanges(dirty:boolean){
 const [destination,setDestination]=useState<string|null>(null),dialog=useRef<HTMLDialogElement>(null),leaving=useRef(false),router=useRouter();
 useEffect(()=>{if(destination)dialog.current?.showModal();},[destination]);
 useEffect(()=>{
  if(!dirty)return;
  const unload=(event:BeforeUnloadEvent)=>{if(leaving.current)return;event.preventDefault();event.returnValue="";};
  const navigate=(event:MouseEvent)=>{
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   const link=event.target instanceof Element?event.target.closest("a"):null;
   if(!link||link.target==="_blank"||link.hasAttribute("download")||!shouldGuardLink(link.href,location.href))return;
   event.preventDefault();event.stopPropagation();setDestination(link.href);
  };
  window.addEventListener("beforeunload",unload);document.addEventListener("click",navigate,true);
  return()=>{window.removeEventListener("beforeunload",unload);document.removeEventListener("click",navigate,true);};
 },[dirty]);
 function dismiss(){dialog.current?.close();setDestination(null);}
 return destination?<dialog ref={dialog} aria-label="Unsaved changes" onCancel={event=>{event.preventDefault();dismiss();}} className="discard-dialog"><h2>Keep your unsaved changes?</h2><p>Leaving this page discards the changes you have not saved.</p><div className="row"><button className="button button-primary" type="button" onClick={dismiss}>Keep editing</button><button className="button button-outline" type="button" onClick={()=>{leaving.current=true;const url=new URL(destination);dismiss();if(url.origin===location.origin)router.push(url.pathname+url.search+url.hash);else location.assign(url.href);}}>Discard & leave</button></div></dialog>:null;
}
