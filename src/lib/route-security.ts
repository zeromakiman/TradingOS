import "server-only";
import { supabaseServer } from "./supabase/server";
import { operationalFailure } from "./operational-log";
export class RequestError extends Error {constructor(message:string,public status=400){super(message);}}
export async function routeUser(request:Request,mutation=false){
 // Next's internal request URL can use its bind hostname. The browser's Host
 // remains authoritative for same-origin comparison; never trust forwarded-host.
 const url=new URL(request.url),host=request.headers.get("host")??url.host;
 if(mutation && request.headers.get("origin")!==`${url.protocol}//${host}`)throw new RequestError("Same-origin request required",403);
 const db=await supabaseServer();const {data,error}=await db.auth.getUser();
 if(error&&(error.status===429||(error.status??0)>=500||error.name==="AuthRetryableFetchError")){operationalFailure("auth_unavailable",503);throw new RequestError("Sign-in service is temporarily unavailable. Please try again.",503);}
 if(error||!data.user)throw new RequestError("Sign in required",401);
 return {db,user:data.user};
}
export function routeError(error:unknown){const status=error instanceof RequestError?error.status:500;if(status>=500)operationalFailure("request_failed",status);return Response.json({error:error instanceof RequestError?error.message:"The request failed. Please try again."},{status,headers:{"Cache-Control":"no-store"}});}
export async function boundedBody(request:Request,limit:number){
 if(Number(request.headers.get("content-length")??0)>limit)throw new RequestError("Upload exceeds the size limit",413);
 const reader=request.body?.getReader();if(!reader)throw new RequestError("Missing request body");
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new RequestError("Upload exceeds the size limit",413);chunks.push(value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
