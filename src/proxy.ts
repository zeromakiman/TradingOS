import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicConfig } from "./lib/supabase/config";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const cacheHeaders = new Headers({"Cache-Control":"private, no-cache, no-store, must-revalidate, max-age=0",Expires:"0",Pragma:"no-cache"});
  const path = request.nextUrl.pathname;
  // Route handlers retain their JSON/CSV 401 behavior while sharing cookie refresh.
  const isPrivate = !["/login", "/forgot-password", "/update-password"].includes(path) && !path.startsWith("/api/") && path !== "/edge/export";
  const config = publicConfig();
  if (!config) {
    return isPrivate ? NextResponse.redirect(new URL("/login", request.url)) : response;
  }
  const hadSession = request.cookies.getAll().some(c=>c.name.startsWith(config.cookiePrefix));
  const changed = new Map<string,{name:string;value:string;options:CookieOptions}>();
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        for(const cookie of values){request.cookies.set(cookie.name,cookie.value);changed.set(cookie.name,cookie);}
        response = NextResponse.next({ request });
        for(const {name,value,options} of changed.values()) response.cookies.set(name,value,options);
        for(const [key,value] of Object.entries(headers)) cacheHeaders.set(key,value);
      }
    }
  });
  const { data, error } = await supabase.auth.getClaims();
  const unavailable=error && (error.status === 429 || (error.status ?? 0)>=500 || error.name === "AuthRetryableFetchError");
  if (isPrivate && !unavailable && (error || !data?.claims)) {
    const denied = NextResponse.redirect(new URL(hadSession ? "/login?reason=session":"/login", request.url));
    for(const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
    cacheHeaders.forEach((value,key)=>{denied.headers.set(key,value);});
    return denied;
  }
  cacheHeaders.forEach((value,key)=>{response.headers.set(key,value);});
  return response;
}
export const config = { matcher: ["/today/:path*", "/analyze/:path*", "/journal/:path*", "/edge", "/edge/export", "/api/:path*", "/settings/:path*", "/login", "/forgot-password", "/update-password"] };

