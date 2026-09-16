"use client";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { useUnsavedChanges } from "./unsaved-changes";
import type { ActionState } from "@/app/actions";
export function ActionForm({ action, children, label, pendingLabel="Saving…", className = "form-stack", guardUnsaved=false,requestKey }: { action: (state: ActionState, form: FormData) => Promise<ActionState>; children: React.ReactNode; label: string; pendingLabel?:string; className?: string; guardUnsaved?:boolean;requestKey?:string }) {
 const [state, formAction, pending] = useActionState(action, {}),[dirty,setDirty]=useState(false),errorRef=useRef<HTMLParagraphElement>(null),submittedValues=useRef<Array<{element:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;value:string;checked:boolean}>>([]);
 const [submissionKey,setSubmissionKey]=useState(requestKey),errorId=useId();
 const unsavedDialog=useUnsavedChanges(guardUnsaved&&dirty&&!pending);
 useEffect(()=>{if(state.success){setDirty(false);if(requestKey)setSubmissionKey(crypto.randomUUID());}if(state.error){for(const item of submittedValues.current){if(!item.element.isConnected||item.element instanceof HTMLInputElement&&item.element.type==="password")continue;item.element.value=item.value;if(item.element instanceof HTMLInputElement)item.element.checked=item.checked;}errorRef.current?.focus();}submittedValues.current=[];},[state,requestKey]);
 return <form action={formAction} className={className} onSubmit={e=>{submittedValues.current=Array.from(e.currentTarget.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>("input,select,textarea")).filter(element=>!(element instanceof HTMLInputElement&&["file","hidden","password"].includes(element.type))).map(element=>({element,value:element.value,checked:element instanceof HTMLInputElement&&element.checked}));}} onChange={()=>setDirty(true)} aria-busy={pending}>
   {unsavedDialog}{submissionKey&&<input type="hidden" name="requestKey" value={submissionKey}/>}<fieldset disabled={pending} className="action-fields" aria-describedby={state.error?errorId:undefined}>{children}</fieldset>
   {state.error && <p id={errorId} ref={errorRef} tabIndex={-1} className="notice danger" role="alert">{state.error}</p>}
   {state.success && <p className="notice success" role="status">{state.success}</p>}
   <Button disabled={pending} type="submit">{pending ? pendingLabel : label}</Button>
 </form>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
 // biome-ignore lint/a11y/noLabelWithoutControl: Each Field supplies its control inside this label.
 return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
