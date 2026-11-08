import { afterEach,beforeEach,describe,it,expect,vi } from "vitest";
// The V1 upload route POST /api/setups/[id]/screenshots was removed in V2 (docs/V2_ARCHITECTURE.md §1.2 keeps only the
// legacy download route). Its upload boundaries are asserted on POST /api/trades/[id]/evidence in
// tests/v2-routes-evidence.test.ts and tests/v2-v1-replacements-routes.test.ts.
const mock=vi.hoisted(()=>({getUser:vi.fn(),from:vi.fn(),trusted:vi.fn(),download:vi.fn(),analyze:vi.fn(),logged:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({supabaseServer:async()=>({auth:{getUser:mock.getUser},from:mock.from,storage:{from:()=>({download:mock.download})}})}));
vi.mock("@/lib/supabase/admin",()=>({trustedServer:mock.trusted}));
vi.mock("@/lib/setup-analysis",()=>({analyzeSetup:mock.analyze}));
vi.mock("@/lib/operational-log",()=>({operationalFailure:mock.logged}));
import { GET } from "@/app/api/screenshots/[id]/route";
import { POST as analyze } from "@/app/api/setups/[id]/analyze/route";
const owner="10000000-0000-4000-8000-000000000001",id="20000000-0000-4000-8000-000000000001";
function row(data:unknown){const query={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data,error:null})};query.select.mockReturnValue(query);query.eq.mockReturnValue(query);mock.from.mockReturnValue(query);return query;}
beforeEach(()=>{vi.clearAllMocks();mock.getUser.mockResolvedValue({data:{user:{id:owner}},error:null});});
afterEach(()=>{vi.unstubAllEnvs();});
describe("authenticated legacy download boundaries",()=>{
 it("denies cross-user image downloads without a privileged bypass",async()=>{row(null);expect((await GET(new Request(`http://localhost:3000/api/screenshots/${id}`),{params:Promise.resolve({id})})).status).toBe(404);expect(mock.trusted).not.toHaveBeenCalled();expect(mock.download).not.toHaveBeenCalled();});
 it("serves private image bytes without a public URL or cache",async()=>{row({storage_path:`${owner}/${id}/image`,mime_type:"image/png"});mock.download.mockResolvedValue({data:new Blob([new Uint8Array([1,2,3])]),error:null});const r=await GET(new Request(`http://localhost:3000/api/screenshots/${id}`),{params:Promise.resolve({id})});expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");expect(mock.trusted).not.toHaveBeenCalled();});
});

// POST /api/setups/[id]/analyze (legacy evaluator, kept but not linked from V2) with AI on: a missing or malformed body is
// the caller's mistake. It answers 400 in the standard error shape before any evaluation work, and logs no server failure.
describe("legacy Analyze request body",()=>{
 const evaluationId="30000000-0000-4000-8000-000000000001";
 const post=(body?:string,headers:Record<string,string>={origin:"http://localhost:3000"})=>analyze(new Request(`http://localhost:3000/api/setups/${id}/analyze`,{method:"POST",headers,...(body===undefined?{}:{body})}),{params:Promise.resolve({id})});
 beforeEach(()=>{vi.stubEnv("AI_ENABLED","true");vi.stubEnv("OPENAI_API_KEY","mock-only");mock.analyze.mockResolvedValue({id:evaluationId,replayed:false});});
 it.each([
  ["an empty body",""],["invalid JSON","{"],["a JSON string",JSON.stringify("NORMAL")],["an empty object","{}"],
  ["an evaluation id that is not a UUID",JSON.stringify({evaluationId:"x",mode:"NORMAL"})],["an unknown mode",JSON.stringify({evaluationId,mode:"FAST"})],
  ["an unknown field",JSON.stringify({evaluationId,mode:"NORMAL",userId:owner})],
 ])("refuses %s with 400 and never starts an evaluation",async(_label,body)=>{
  const r=await post(body);
  expect(r.status).toBe(400);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toEqual({error:"Send a JSON body with an evaluationId (UUID) and a mode (NORMAL or DEEP)."});
  expect(mock.analyze).not.toHaveBeenCalled();
  expect(mock.logged).not.toHaveBeenCalled();
 });
 it("refuses a request without any body with 400 as well",async()=>{const r=await post();expect(r.status).toBe(400);expect(await r.json()).toEqual({error:"Missing request body"});expect(mock.analyze).not.toHaveBeenCalled();expect(mock.logged).not.toHaveBeenCalled();});
 it("refuses an oversized body with 413 before reading it as JSON",async()=>{const r=await post(JSON.stringify({evaluationId,mode:"NORMAL",pad:"x".repeat(5000)}));expect(r.status).toBe(413);expect(mock.analyze).not.toHaveBeenCalled();});
 it("passes a valid body to the evaluator unchanged",async()=>{const r=await post(JSON.stringify({evaluationId,mode:"DEEP"}));expect(r.status).toBe(200);expect(await r.json()).toEqual({id:evaluationId,replayed:false});expect(mock.analyze).toHaveBeenCalledExactlyOnceWith(id,evaluationId,"DEEP");});
 it("keeps sign-in, same-origin, the disabled response and the unknown-proposal answer ahead of the body check",async()=>{
  expect((await post("{",{})).status).toBe(403);
  mock.getUser.mockResolvedValueOnce({data:{user:null},error:null});
  expect((await post("{")).status).toBe(401);
  const unknown=await analyze(new Request("http://localhost:3000/api/setups/x/analyze",{method:"POST",headers:{origin:"http://localhost:3000"},body:"{"}),{params:Promise.resolve({id:"x"})});
  expect(unknown.status).toBe(404);
  vi.stubEnv("AI_ENABLED","false");
  const disabled=await post("{");
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toEqual({status:"DISABLED",message:"AI analysis is currently disabled"});
  expect(mock.analyze).not.toHaveBeenCalled();
 });
});
