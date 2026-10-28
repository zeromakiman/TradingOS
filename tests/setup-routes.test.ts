import { beforeEach,describe,it,expect,vi } from "vitest";
// The V1 upload route POST /api/setups/[id]/screenshots was removed in V2 (docs/V2_ARCHITECTURE.md §1.2 keeps only the
// legacy download route). Its upload boundaries are asserted on POST /api/trades/[id]/evidence in
// tests/v2-routes-evidence.test.ts and tests/v2-v1-replacements-routes.test.ts.
const mock=vi.hoisted(()=>({getUser:vi.fn(),from:vi.fn(),trusted:vi.fn(),download:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({supabaseServer:async()=>({auth:{getUser:mock.getUser},from:mock.from,storage:{from:()=>({download:mock.download})}})}));
vi.mock("@/lib/supabase/admin",()=>({trustedServer:mock.trusted}));
import { GET } from "@/app/api/screenshots/[id]/route";
const owner="10000000-0000-4000-8000-000000000001",id="20000000-0000-4000-8000-000000000001";
function row(data:unknown){const query={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data,error:null})};query.select.mockReturnValue(query);query.eq.mockReturnValue(query);mock.from.mockReturnValue(query);return query;}
beforeEach(()=>{vi.clearAllMocks();mock.getUser.mockResolvedValue({data:{user:{id:owner}},error:null});});
describe("authenticated legacy download boundaries",()=>{
 it("denies cross-user image downloads without a privileged bypass",async()=>{row(null);expect((await GET(new Request(`http://localhost:3000/api/screenshots/${id}`),{params:Promise.resolve({id})})).status).toBe(404);expect(mock.trusted).not.toHaveBeenCalled();expect(mock.download).not.toHaveBeenCalled();});
 it("serves private image bytes without a public URL or cache",async()=>{row({storage_path:`${owner}/${id}/image`,mime_type:"image/png"});mock.download.mockResolvedValue({data:new Blob([new Uint8Array([1,2,3])]),error:null});const r=await GET(new Request(`http://localhost:3000/api/screenshots/${id}`),{params:Promise.resolve({id})});expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");expect(mock.trusted).not.toHaveBeenCalled();});
});
