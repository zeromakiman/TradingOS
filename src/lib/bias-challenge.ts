import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadSetup } from "./setup-data";
import { accountAiAvailability,serverAiLedger } from "./ai-budget";
import { trustedServer } from "./supabase/admin";
import { SCREENSHOT_BUCKET } from "./screenshots";
import { operationFor } from "@/ai/operations";
import { operationContract } from "@/ai/operation-contract";
import { providerKey } from "@/ai/provider-config";
import { budgetedAiRequest } from "@/ai/request-gate";
import { ProviderError } from "@/ai/provider";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { validateBiasChallenge } from "@/ai/bias-challenge-contract";
export async function challengeBias(proposalId:string,requestId:string,selectedIds:string[]) {
 const operation=operationFor("CHALLENGE_BIAS");
 z.uuid().parse(requestId);z.array(z.uuid()).max(operation.maxImages).parse(selectedIds);
 if(new Set(selectedIds).size!==selectedIds.length)throw new Error("Duplicate evidence selection");
 const s=await loadSetup(proposalId);
 if(s.lock)return {status:"LOCKED",message:"This plan is already locked. Earlier challenges remain available as advisory history."};
 const availability=await accountAiAvailability(s.proposal.account_id,operation.id);
 if(availability.status!=="ENABLED")return {status:availability.status,message:availability.message};
 const selected=selectedIds.map(id=>s.screenshots.find(x=>x.id===id&&x.proposal_id===s.proposal.id&&x.user_id===s.user.id&&!s.removals.some(r=>r.screenshot_id===id)));
 if(selected.some(x=>!x))throw new Error("Selected evidence is unavailable for this proposal");
 const evidence=selected.filter((x):x is NonNullable<typeof x>=>!!x);
 const facts=biasChallengeContext(s,evidence);
 if(Buffer.byteLength(JSON.stringify(facts))>64000)throw new Error("Proposal exceeds bounded challenge context limit");
 const admin=trustedServer(),start=await admin.rpc("start_bias_challenge",{p_id:requestId,p_user_id:s.user.id,p_proposal_id:s.proposal.id,p_facts:facts,p_hash:createHash("sha256").update(JSON.stringify(facts)).digest("hex"),p_operation:operation,p_contract:operationContract(operation)});
 if(start.error)throw new Error("Could not start challenge. Refresh to check locked state and existing attempts.");
 if(start.data!==true)return {status:"RECORDED",message:"This challenge request was already recorded. No additional provider request was made."};
 let reservationId:string|null=null,raw:unknown=null,interpretation:ReturnType<typeof validateBiasChallenge>|null=null,errorCode:string|null=null;
 const authorize=async()=>{const {error}=await admin.rpc("authorize_bias_challenge",{p_id:requestId,p_user_id:s.user.id});if(error)throw new ProviderError("PROPOSAL_OR_EVIDENCE_CHANGED");};
 try {
  const images=[];
  for(const image of evidence){
   const {data,error}=await s.db.storage.from(SCREENSHOT_BUCKET).download(image.storage_path);
   if(error||!data)throw new ProviderError("SCREENSHOT_UNAVAILABLE");
   const bytes=Buffer.from(await data.arrayBuffer());
   if(bytes.length!==image.byte_size||createHash("sha256").update(bytes).digest("hex")!==image.sha256)throw new ProviderError("SCREENSHOT_CHANGED");
   images.push({sourceId:`evidence:${image.id}`,role:image.role,dataUrl:`data:${image.mime_type};base64,${bytes.toString("base64")}`});
  }
  const ledger=serverAiLedger();
  const result=await budgetedAiRequest({apiKey:providerKey(operation.provider),config:{model:operation.model,reasoningEffort:operation.reasoningEffort,timeoutMs:operation.timeoutMs,maxOutputTokens:operation.maxOutputTokens,imageDetail:operation.imageDetail,deepEnabled:false},context:facts,images,prior:[]},{userId:s.user.id,accountId:s.proposal.account_id,operationId:requestId,stage:"A",operation:operation.id},{...ledger,reserve:async record=>{await authorize();await ledger.reserve(record);reservationId=record.id;},dispatch:async(...args)=>{await authorize();await ledger.dispatch(...args);},recheck:async(...args)=>{await authorize();await ledger.recheck(...args);}});
  raw=result.output;interpretation=validateBiasChallenge(raw,facts.sourceRefs);
 }catch(error){errorCode=error instanceof ProviderError?error.code:raw!==null?"INVALID_CHALLENGE_OUTPUT":"CHALLENGE_FAILED";}
 const finish=await admin.rpc("finish_bias_challenge",{p_id:requestId,p_user_id:s.user.id,p_status:interpretation?"COMPLETED":"FAILED",p_interpretation:interpretation,p_error:errorCode,p_raw:raw,p_reservation_id:reservationId});
 if(finish.error)throw new Error("Challenge could not finish saving. Check history before retrying; no automatic retry occurred.");
 return {status:interpretation?"COMPLETED":"FAILED",message:interpretation?"Challenge saved. Proposal and Risk Engine permission are unchanged.":"Challenge failed. The attempt and protected accounting remain in history."};
}
