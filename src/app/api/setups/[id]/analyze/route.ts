import { z } from "zod";
import { analyzeSetup } from "@/lib/setup-analysis";
import { boundedBody, RequestError, routeError, routeUser } from "@/lib/route-security";
import { aiAvailability } from "@/ai/availability";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  await routeUser(request,true);
  const availability=aiAvailability();
  if(availability.status==="DISABLED")return Response.json({status:availability.status,message:availability.message},{headers:{"Cache-Control":"no-store"}});
  if(availability.status==="CONFIGURATION_ERROR")throw new RequestError(availability.message,503);
  const {id}=await params;
  if(!z.uuid().safeParse(id).success)throw new RequestError("Proposal not found",404);
  const body=z.object({evaluationId:z.uuid(),mode:z.enum(["NORMAL","DEEP"])}).strict().parse(JSON.parse((await boundedBody(request,4096)).toString("utf8")));
  try{return Response.json(await analyzeSetup(id,body.evaluationId,body.mode),{headers:{"Cache-Control":"no-store"}});}catch(e){
   if(e instanceof Error&&!e.message.startsWith("NEXT_"))throw new RequestError(e.message,503);throw e;
  }
 }catch(e){return routeError(e);}
}
