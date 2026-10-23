import { beforeEach,describe,it,expect,vi } from "vitest";
const mock=vi.hoisted(()=>({getUser:vi.fn(),load:vi.fn(),claims:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({supabaseServer:async()=>({auth:{getUser:mock.getUser}})}));
vi.mock("@/lib/analytics-data",()=>({loadJournalAnalytics:mock.load}));
vi.mock("@supabase/ssr",()=>({createServerClient:()=>({auth:{getClaims:mock.claims}})}));
vi.mock("@/lib/supabase/config",()=>({publicConfig:()=>({url:"https://example.supabase.co",key:"public",cookiePrefix:"sb-test"})}));
import { GET } from "@/app/edge/export/route";
import { proxy,config } from "@/proxy";
import { NextRequest } from "next/server";
import { createRequire } from "node:module";
// The proxy matcher is a catch-all (docs/V2_ARCHITECTURE.md §1.3): coverage is checked with Next's own matcher compiler.
const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info.js") as { getMiddlewareMatchers(matcher: unknown, nextConfig: object): { regexp: string }[] };
const proxyCovers = (path: string) => getMiddlewareMatchers(config.matcher, {}).some(m => new RegExp(m.regexp).test(path));
beforeEach(()=>{vi.clearAllMocks();mock.getUser.mockResolvedValue({data:{user:{id:"owner"}},error:null});mock.load.mockResolvedValue({trades:[]});mock.claims.mockResolvedValue({data:null,error:null});});
describe("EDGE authentication and private export",()=>{
 it("denies anonymous CSV before loading any journal data",async()=>{mock.getUser.mockResolvedValue({data:{user:null},error:null});expect((await GET(new Request("http://localhost/edge/export"))).status).toBe(401);expect(mock.load).not.toHaveBeenCalled();});
 it("rejects invalid date ranges",async()=>{expect((await GET(new Request("http://localhost/edge/export?from=2026-02-30"))).status).toBe(400);expect(mock.load).not.toHaveBeenCalled();});
 it("returns a private header-only CSV for an empty authenticated journal",async()=>{const r=await GET(new Request("http://localhost/edge/export?account=selected"));expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");expect(mock.load).toHaveBeenCalledWith("selected");expect((await r.text()).split("\r\n")).toHaveLength(1);});
 it("protects the EDGE page before streaming and refreshes its session",async()=>{expect(proxyCovers("/edge")).toBe(true);const r=await proxy(new NextRequest("http://localhost/edge"));expect(r.status).toBe(307);expect(r.headers.get("location")).toBe("http://localhost/login");expect(r.headers.get("cache-control")).toContain("no-store");});
 it("keeps authenticated EDGE pages private",async()=>{mock.claims.mockResolvedValue({data:{claims:{sub:"owner"}},error:null});const r=await proxy(new NextRequest("http://localhost/edge"));expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toContain("private");});
});
