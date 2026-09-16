import { randomUUID } from "node:crypto";
import { z } from "zod";
import { trustedServer } from "@/lib/supabase/admin";
import { operationalFailure } from "@/lib/operational-log";
import { boundedBody, RequestError, routeError, routeUser } from "@/lib/route-security";
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_BUCKET, SCREENSHOT_ROLES, validateScreenshot } from "@/lib/screenshots";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {db,user}=await routeUser(request,true),{id}=await params;if(!z.uuid().safeParse(id).success)throw new RequestError("Unknown proposal",404);
  const {data:proposal,error}=await db.from("setup_proposals").select("id,account_id").eq("id",id).eq("user_id",user.id).maybeSingle();
  if(error)throw new RequestError("Unable to load this proposal. Please try again.",503);
  if(!proposal)throw new RequestError("Unknown proposal",404);
  const bytes=await boundedBody(request,MAX_SCREENSHOT_BYTES+65536);
  let form:FormData;try{form=await new Response(bytes,{headers:{"Content-Type":request.headers.get("content-type")??""}}).formData();}catch{throw new RequestError("Choose a chart file and timeframe");}
  const role=z.enum(SCREENSHOT_ROLES).safeParse(form.get("role")),file=form.get("file");
  if(!role.success||!(file instanceof File))throw new RequestError("Choose a chart file and timeframe");
  let metadata:Awaited<ReturnType<typeof validateScreenshot>>;try{metadata=await validateScreenshot(Buffer.from(await file.arrayBuffer()),file.type);}catch(e){throw new RequestError(e instanceof Error?e.message:"Invalid image");}
  let admin:ReturnType<typeof trustedServer>;try{admin=trustedServer();}catch(e){throw new RequestError(e instanceof Error?e.message:"Storage is not configured",503);}
  const imageId=randomUUID(),path=`${user.id}/${id}/${imageId}`;
  const {error:uploadError}=await admin.storage.from(SCREENSHOT_BUCKET).upload(path,await file.arrayBuffer(),{contentType:file.type,upsert:false});
  if(uploadError){operationalFailure("storage_upload_failed",503);throw new RequestError("Private storage upload failed. Please try again.",503);}
  const {error:saveError}=await admin.from("setup_screenshots").insert({id:imageId,user_id:user.id,account_id:proposal.account_id,proposal_id:id,role:role.data,storage_path:path,original_filename:[...file.name].filter(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127).join("").slice(0,255)||"chart",...metadata});
  if(saveError){const cleanup=await admin.storage.from(SCREENSHOT_BUCKET).remove([path]);if(cleanup.error)operationalFailure("storage_cleanup_failed",503);if(saveError.message==="Screenshot limit reached")throw new RequestError("A setup supports eight active screenshots. Remove one before uploading another.",409);operationalFailure("storage_registration_failed",503);throw new RequestError("Screenshot metadata could not be saved",503);}
  return Response.json({id:imageId},{status:201,headers:{"Cache-Control":"no-store"}});
 }catch(e){return routeError(e);}
}
