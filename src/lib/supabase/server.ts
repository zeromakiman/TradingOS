import "server-only";
import { type CookieOptions, createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { authCookieOptions, isSecureRequest } from "../cookie-security";
import { requestFetch } from "../perf";
import { publicConfig } from "./config";

export function isConfigured() {
  return publicConfig() !== null;
}

/**
 * The request's Supabase client on the browser's session cookies. Only a writable client (server actions) sets cookies
 * (a page render cannot); it writes them with authCookieOptions: HttpOnly, and Secure when the request came over HTTPS.
 */
export async function supabaseServer(writable = false) {
  const config = publicConfig();
  if (!config) throw new Error("Supabase has not been configured.");
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  const secure = writable && isSecureRequest(requestHeaders);
  const fetch = requestFetch(requestHeaders);
  return createServerClient(config.url, config.key, {
    ...(fetch ? { global: { fetch } } : {}),
    cookieOptions: authCookieOptions(secure),
    cookies: {
      getAll: () => jar.getAll(),
      ...(writable ? { setAll: (values: {name:string;value:string;options:CookieOptions}[]) => { for(const {name,value,options} of values) jar.set(name,value,options); } } : {})
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
