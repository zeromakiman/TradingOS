/**
 * Security attributes of the cookies Trading OS writes. A plain module without server-only imports: the proxy
 * (src/proxy.ts), the server actions' Supabase client (src/lib/supabase/server.ts) and the trading-account context
 * cookies (src/lib/account-context.ts) all use it without importing each other.
 */

/**
 * Whether a request reached the app over HTTPS: the browser's Origin, else the forwarded protocol of the hosting proxy.
 * Cookies written while answering it get the Secure attribute, so they never travel over plain HTTP.
 */
export function isSecureRequest(requestHeaders: Pick<Headers, "get">): boolean {
  const origin = requestHeaders.get("origin");
  if (origin) {
    try {
      return new URL(origin).protocol === "https:";
    } catch {
      return false;
    }
  }
  return requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/**
 * Attributes of every Supabase auth cookie (access and refresh token, PKCE code verifier), wherever the server writes
 * one: the server actions' client and the proxy's session refresh. No browser code creates a Supabase client or reads
 * these cookies, so they are HttpOnly and a script on the page can never read the tokens; Secure on HTTPS. @supabase/ssr
 * merges them over its defaults (which are not HttpOnly) and adds its 400-day lifetime, or Max-Age=0 when it removes one.
 */
export function authCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
}
