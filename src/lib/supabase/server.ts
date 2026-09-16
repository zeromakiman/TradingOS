import "server-only";
import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { publicConfig } from "./config";

export function isConfigured() {
  return publicConfig() !== null;
}
export async function supabaseServer(writable = false) {
  const config = publicConfig();
  if (!config) throw new Error("Supabase has not been configured.");
  const jar = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => jar.getAll(),
      ...(writable ? { setAll: (values: {name:string;value:string;options:import("@supabase/ssr").CookieOptions}[]) => { for(const {name,value,options} of values) jar.set(name,value,options); } } : {})
    }
  });
}
export async function requireUser(writable = false) {
  if (!isConfigured()) redirect("/login");
  const db = await supabaseServer(writable);
  const { data, error } = await db.auth.getUser();
  if (error && (isAuthRetryableFetchError(error) || error.status === 429 || (error.status ?? 0) >= 500)) throw new Error("Sign-in service is temporarily unavailable. Please try again.");
  if (error || !data.user) redirect("/login?reason=session");
  return { db, user: data.user };
}
