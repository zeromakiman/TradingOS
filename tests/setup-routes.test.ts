import { beforeEach,describe,it,expect,vi } from "vitest";
import sharp from "sharp";
const mock=vi.hoisted(()=>({getUser:vi.fn(),from:vi.fn(),upload:vi.fn(),remove:vi.fn(),insert:vi.fn(),trusted:vi.fn(),download:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({supabaseServer:async()=>({auth:{getUser:mock.getUser},from:mock.from,storage:{from:()=>({download:mock.download})}})}));
vi.mock("@/lib/supabase/admin",()=>({trustedServer:mock.trusted}));
import { POST } from "@/app/api/setups/[id]/screenshots/route";
import { GET } from "@/app/api/screenshots/[id]/route";
const owner="10000000-0000-4000-8000-000000000001",id="20000000-0000-4000-8000-000000000001",account="30000000-0000-4000-8000-000000000001";
function row(data:unknown){const query={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data,error:null})};query.select.mockReturnValue(query);query.eq.mockReturnValue(query);mock.from.mockReturnValue(query);return query;}
beforeEach(()=>{vi.clearAllMocks();mock.getUser.mockResolvedValue({data:{user:{id:owner}},error:null});row({id,account_id:account});mock.trusted.mockReturnValue({storage:{from:()=>({upload:mock.upload,remove:mock.remove})},from:()=>({insert:mock.insert})});mock.upload.mockResolvedValue({error:null});mock.insert.mockResolvedValue({error:null});mock.remove.mockResolvedValue({error:null});});
async function request(bytes?:Buffer,mime="image/png",origin="http://localhost:3000"){
 const file=bytes??await sharp({create:{width:8,height:8,channels:3,background:"white"}}).png().toBuffer();const form=new FormData();form.set("role","H4");form.set("user_id","forged");form.set("file",new Blob([new Uint8Array(file)],{type:mime}),"chart.png");return new Request(`http://localhost:3000/api/setups/${id}/screenshots`,{method:"POST",headers:{origin},body:form});
}
describe("authenticated upload and download boundaries",()=>{
 it("rejects unsigned requests before touching privileged storage",async()=>{mock.getUser.mockResolvedValue({data:{user:null},error:null});expect((await POST(await request(),{params:Promise.resolve({id})})).status).toBe(401);expect(mock.trusted).not.toHaveBeenCalled();});
 it("rejects cross-origin uploads",async()=>{expect((await POST(await request(undefined,"image/png","https://attacker.invalid"),{params:Promise.resolve({id})})).status).toBe(403);expect(mock.trusted).not.toHaveBeenCalled();});
 it("accepts the browser Host when Next uses an internal bind hostname",async()=>{const r=await request(undefined,"image/png","http://127.0.0.1:3000");r.headers.set("host","127.0.0.1:3000");expect((await POST(r,{params:Promise.resolve({id})})).status).toBe(201);});
 it("does not accept an attacker-controlled forwarded Host",async()=>{const r=await request(undefined,"image/png","https://attacker.invalid");r.headers.set("host","localhost:3000");r.headers.set("x-forwarded-host","attacker.invalid");expect((await POST(r,{params:Promise.resolve({id})})).status).toBe(403);});
 it("rejects another user's proposal before upload",async()=>{row(null);expect((await POST(await request(),{params:Promise.resolve({id})})).status).toBe(404);expect(mock.trusted).not.toHaveBeenCalled();});
 it("rejects spoofed images before storage mutation",async()=>{expect((await POST(await request(Buffer.from('<svg onload="x"/>')),{params:Promise.resolve({id})})).status).toBe(400);expect(mock.upload).not.toHaveBeenCalled();});
 it("stores the authenticated owner and validated metadata, ignoring form identity",async()=>{const q=row({id,account_id:account});const response=await POST(await request(),{params:Promise.resolve({id})});expect(response.status).toBe(201);expect(q.eq).toHaveBeenCalledWith("user_id",owner);expect(mock.insert.mock.calls[0][0]).toMatchObject({user_id:owner,account_id:account,proposal_id:id,role:"H4",width:8,height:8});expect(mock.upload.mock.calls[0][0]).toMatch(new RegExp(`^${owner}/${id}/`));});
 it("cleans up an unregistered upload if metadata persistence fails",async()=>{mock.insert.mockResolvedValue({error:{message:"failed"}});expect((await POST(await request(),{params:Promise.resolve({id})})).status).toBe(503);expect(mock.remove).toHaveBeenCalledWith([mock.upload.mock.calls[0][0]]);});
 it("denies cross-user image downloads without a privileged bypass",async()=>{row(null);expect((await GET(new Request(`http://localhost:3000/api/screenshots/${id}`),{params:Promise.resolve({id})})).status).toBe(404);expect(mock.trusted).not.toHaveBeenCalled();expect(mock.download).not.toHaveBeenCalled();});
 it("serves private image bytes without a public URL or cache",async()=>{row({storage_path:`${owner}/${id}/image`,mime_type:"image/png"});mock.download.mockResolvedValue({data:new Blob([new Uint8Array([1,2,3])]),error:null});const r=await GET(new Request(`http://localhost:3000/api/screenshots/${id}`),{params:Promise.resolve({id})});expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("private, no-store");expect(mock.trusted).not.toHaveBeenCalled();});
});
