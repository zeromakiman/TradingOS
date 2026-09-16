export type PublicConfig = { url: string; key: string; cookiePrefix: string };
export function readPublicConfig(env: { url?: string; key?: string }): PublicConfig | null {
  if (!env.url?.trim() && !env.key?.trim()) return null;
  if (!env.url?.trim() || !env.key?.trim()) throw new Error("Supabase configuration is incomplete.");
  let url: URL;
  try { url=new URL(env.url.trim()); } catch { throw new Error("Supabase project URL is invalid."); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Use the Supabase project origin only.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname))) throw new Error("Supabase requires HTTPS or a local development origin.");
  const key=env.key.trim();
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new Error("Use a Supabase publishable key. Secret and service-role keys are not accepted.");
  return { url:url.origin,key,cookiePrefix:`sb-${url.hostname.split(".")[0]}-auth-token` };
}
export function publicConfig() { return readPublicConfig({url:process.env.NEXT_PUBLIC_SUPABASE_URL,key:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}); }
