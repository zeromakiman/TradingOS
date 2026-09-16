import { z } from "zod";
import { SCREENSHOT_BUCKET } from "@/lib/screenshots";
import { RequestError, routeError, routeUser } from "@/lib/route-security";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {db,user}=await routeUser(request),{id}=await params;if(!z.uuid().safeParse(id).success)throw new RequestError("Image not found",404);
  const {data:s,error}=await db.from("setup_screenshots").select("storage_path,mime_type").eq("id",id).eq("user_id",user.id).maybeSingle();
  if(error)throw new RequestError("Unable to load this image. Please try again.",503);
  if(!s)throw new RequestError("Image not found",404);
  const {data,error:downloadError}=await db.storage.from(SCREENSHOT_BUCKET).download(s.storage_path);
  if(downloadError||!data)throw new RequestError("Saved image is unavailable",404);
  return new Response(data,{headers:{"Content-Type":s.mime_type,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":"inline"}});
 }catch(e){return routeError(e);}
}
