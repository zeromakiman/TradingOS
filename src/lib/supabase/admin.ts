import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicConfig } from "./config";
export function trustedServer(){
 const config=publicConfig(),key=process.env.SUPABASE_SECRET_KEY;
 if(!config||!key?.startsWith("sb_secret_"))throw new Error("Server storage credentials are not configured. Add SUPABASE_SECRET_KEY to .env.local and restart.");
 return createClient(config.url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
