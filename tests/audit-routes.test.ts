import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
// Failure and refresh boundaries of the kept legacy routes (GET /edge/export, GET /api/screenshots/[id]) and the proxy.
// The V1 upload route POST /api/setups/[id]/screenshots was removed in V2 (docs/V2_ARCHITECTURE.md §1.2); its upload
// boundaries are asserted on POST /api/trades/[id]/evidence in tests/v2-routes-evidence.test.ts and
// tests/v2-v1-replacements-routes.test.ts.
const mock=vi.hoisted(()=>({getUser:vi.fn(),from:vi.fn(),upload:vi.fn(),remove:vi.fn(),insert:vi.fn(),download:vi.fn(),load:vi.fn(),claims:vi.fn(),cookies:null as null|{setAll:(v:{name:string;value:string;options:object}[],h:Record<string,string>)=>void}}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/supabase/server',()=>({supabaseServer:async()=>({auth:{getUser:mock.getUser},from:mock.from,storage:{from:()=>({download:mock.download})}})}));
vi.mock('@/lib/supabase/admin',()=>({trustedServer:()=>({storage:{from:()=>({upload:mock.upload,remove:mock.remove})},from:()=>({insert:mock.insert})})}));
vi.mock('@/app/edge/export/load',async importOriginal=>({...(await importOriginal<typeof import('@/app/edge/export/load')>()),closedTradesExport:mock.load}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined})}));
vi.mock('@supabase/ssr',()=>({createServerClient:(_u:unknown,_k:unknown,o:{cookies:typeof mock.cookies})=>{mock.cookies=o.cookies;return {auth:{getClaims:mock.claims}};}}));
vi.mock('@/lib/supabase/config',()=>({publicConfig:()=>({url:'https://example.supabase.co',key:'public',cookiePrefix:'sb-test'})}));
import {GET as screenshot} from '@/app/api/screenshots/[id]/route';
import {GET as csv} from '@/app/edge/export/route';
import {proxy,config} from '@/proxy';
import {NextRequest} from 'next/server';
import {createRequire} from 'node:module';
// The proxy matcher is a catch-all (docs/V2_ARCHITECTURE.md §1.3): coverage is checked with Next's own matcher compiler.
const {getMiddlewareMatchers}=createRequire(import.meta.url)('next/dist/build/analysis/get-page-static-info.js') as {getMiddlewareMatchers(matcher:unknown,nextConfig:object):{regexp:string}[]};
const proxyCovers=(path:string)=>getMiddlewareMatchers(config.matcher,{}).some(m=>new RegExp(m.regexp).test(path));
const id='20000000-0000-4000-8000-000000000001',owner='10000000-0000-4000-8000-000000000001',account='30000000-0000-4000-8000-000000000001';
let log:ReturnType<typeof vi.spyOn>;
function row(data:unknown,error:unknown=null){const q={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data,error})};q.select.mockReturnValue(q);q.eq.mockReturnValue(q);mock.from.mockReturnValue(q);}
beforeEach(()=>{vi.clearAllMocks();log=vi.spyOn(console,'error').mockImplementation(()=>{});mock.getUser.mockResolvedValue({data:{user:{id:owner}},error:null});row({id,account_id:account});mock.upload.mockResolvedValue({error:null});mock.insert.mockResolvedValue({error:null});mock.remove.mockResolvedValue({error:null});mock.claims.mockResolvedValue({data:{claims:{sub:owner}},error:null});});
afterEach(()=>log.mockRestore());
const context={params:Promise.resolve({id})};
describe('audit failure and refresh boundaries',()=>{
 it('distinguishes an authentication outage from sign-out without leaking credentials',async()=>{mock.getUser.mockResolvedValue({data:{user:null},error:{name:'AuthRetryableFetchError',status:503,message:'SECRET credentials'}});const r=await csv(new Request('http://localhost/edge/export'));expect(r.status).toBe(503);expect(await r.text()).toContain('temporarily unavailable');expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');expect(mock.load).not.toHaveBeenCalled();});
 it('contains a failed CSV query and logs only a fixed operational event',async()=>{mock.load.mockRejectedValue(new Error('SECRET token stack'));const r=await csv(new Request('http://localhost/edge/export'));expect(r.status).toBe(500);expect(await r.text()).not.toMatch(/SECRET|token|stack/);expect(mock.load).toHaveBeenCalledOnce();expect(log).toHaveBeenCalledWith(JSON.stringify({event:'request_failed',status:500}));expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');});
 it('returns a safe missing-image result when bytes are unavailable',async()=>{row({storage_path:'private/path',mime_type:'image/png'});mock.download.mockResolvedValue({data:null,error:{message:'SECRET'}});const r=await screenshot(new Request(`http://localhost/api/screenshots/${id}`),context);expect(r.status).toBe(404);expect(await r.text()).not.toContain('SECRET');});
 it.each([`/api/screenshots/${id}`,'/edge/export'])('propagates refreshed cookies for %s',async path=>{mock.claims.mockImplementation(async()=>{mock.cookies?.setAll([{name:'sb-test-auth-token',value:'refreshed',options:{path:'/'}}],{'Cache-Control':'private, no-store'});return {data:{claims:{sub:owner}},error:null};});const r=await proxy(new NextRequest(`http://localhost${path}`));expect(r.status).toBe(200);expect(r.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');expect(r.headers.get('cache-control')).toContain('no-store');expect(proxyCovers(`/api/screenshots/${id}`)).toBe(true);expect(proxyCovers('/edge/export')).toBe(true);});
 it('leaves signed-out API authorization to the route instead of redirecting it to HTML',async()=>{mock.claims.mockResolvedValue({data:null,error:null});const r=await proxy(new NextRequest('http://localhost/edge/export'));expect(r.status).toBe(200);expect(r.headers.has('location')).toBe(false);});
 it.each(['/forgot-password','/update-password'])('permits recovery bootstrap without a session at %s but disables caching',async path=>{mock.claims.mockResolvedValue({data:null,error:null});const r=await proxy(new NextRequest(`http://localhost${path}`));expect(r.status).toBe(200);expect(r.headers.has('location')).toBe(false);expect(r.headers.get('cache-control')).toContain('no-store');expect(proxyCovers(path)).toBe(true);});
 it.each(['/today','/journal','/settings','/edge'])('still denies signed-out private navigation to %s',async path=>{mock.claims.mockResolvedValue({data:null,error:null});const r=await proxy(new NextRequest(`http://localhost${path}`));expect(r.status).toBe(307);expect(r.headers.get('location')).toBe('http://localhost/login');});
});

