import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
// Optional-AI isolation: the availability flag, the provider and the legacy evaluator endpoint fail closed. The V1
// SetupControls test that lived here (risk and upload controls stay usable while AI is off) moved with the component's
// V2 replacement: tests/v2-v1-replacements-ai-history.test.ts ("pre-trade AI tools while AI cannot run") and
// tests/v2-screen-trade.test.ts (drafts render Check risk, Lock plan and the evidence stager without AI).
const mocks=vi.hoisted(()=>({load:vi.fn(),admin:vi.fn(),user:vi.fn(),transport:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/setup-data",()=>({loadSetup:mocks.load}));
vi.mock("@/lib/supabase/admin",()=>({trustedServer:mocks.admin}));
vi.mock("@/lib/supabase/server",()=>({supabaseServer:async()=>({auth:{getUser:mocks.user}})}));
import { aiAvailability } from "@/ai/availability";
import { callResponses } from "@/ai/provider";
import { modelConfig } from "@/ai/config";
import { analyzeSetup } from "@/lib/setup-analysis";
import { POST } from "@/app/api/setups/[id]/analyze/route";
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("AI_ENABLED","false");vi.stubEnv("OPENAI_API_KEY","");mocks.user.mockResolvedValue({data:{user:{id:"owner"}},error:null});});
afterEach(()=>vi.unstubAllEnvs());
describe("optional AI feature isolation",()=>{
 it.each([undefined,"false","TRUE","1","typo"])("fails closed for flag %s, even with a key and invalid model settings",flag=>{expect(aiAvailability({AI_ENABLED:flag,OPENAI_API_KEY:"fake",OPENAI_SETUP_MODEL:"invalid",OPENAI_SETUP_REASONING:"invalid"})).toMatchObject({status:"DISABLED",message:"AI analysis is currently disabled"});});
 it("requires both explicit enablement and a nonblank key",()=>{expect(aiAvailability({AI_ENABLED:"true"})).toMatchObject({status:"CONFIGURATION_ERROR"});expect(aiAvailability({AI_ENABLED:"true",OPENAI_API_KEY:"  "})).toMatchObject({status:"CONFIGURATION_ERROR"});expect(aiAvailability({AI_ENABLED:"true",OPENAI_API_KEY:"fake"})).toMatchObject({status:"ENABLED"});});
 it("contains invalid model settings within the AI feature",()=>expect(aiAvailability({AI_ENABLED:"true",OPENAI_API_KEY:"fake",OPENAI_SETUP_MODEL:"invalid"})).toMatchObject({status:"CONFIGURATION_ERROR"}));
 it("disabled orchestration neither loads evidence nor writes evaluation history",async()=>{expect(await analyzeSetup("proposal","evaluation","NORMAL")).toMatchObject({status:"DISABLED"});expect(mocks.load).not.toHaveBeenCalled();expect(mocks.admin).not.toHaveBeenCalled();});
 it("direct provider invocation cannot bypass the disabled flag even with a key",async()=>{await expect(callResponses({apiKey:"fake",config:modelConfig({}),context:{},images:[],prior:[]},mocks.transport)).rejects.toThrow("AI analysis is currently disabled");expect(mocks.transport).not.toHaveBeenCalled();});
 it("direct provider invocation with enabled AI and no key cannot reach the network",async()=>{vi.stubEnv("AI_ENABLED","true");await expect(callResponses({apiKey:"",config:modelConfig({}),context:{},images:[],prior:[]},mocks.transport)).rejects.toThrow(/key is missing/);expect(mocks.transport).not.toHaveBeenCalled();});
 it("returns a normal disabled response to a direct Analyze POST",async()=>{const r=await POST(new Request("http://localhost:3000/api/setups/x/analyze",{method:"POST",headers:{origin:"http://localhost:3000"}}),{params:Promise.resolve({id:"x"})});expect(r.status).toBe(200);expect(await r.json()).toEqual({status:"DISABLED",message:"AI analysis is currently disabled"});expect(mocks.load).not.toHaveBeenCalled();expect(mocks.admin).not.toHaveBeenCalled();});
 it("reports missing-key configuration errors only through the AI endpoint",async()=>{vi.stubEnv("AI_ENABLED","true");const r=await POST(new Request("http://localhost:3000/api/setups/x/analyze",{method:"POST",headers:{origin:"http://localhost:3000"}}),{params:Promise.resolve({id:"x"})});expect(r.status).toBe(503);expect((await r.json()).error).toContain("API key is missing");expect(mocks.load).not.toHaveBeenCalled();});
 it("preserves authentication on disabled endpoints",async()=>{mocks.user.mockResolvedValue({data:{user:null},error:null});const r=await POST(new Request("http://localhost:3000/api/setups/x/analyze",{method:"POST",headers:{origin:"http://localhost:3000"}}),{params:Promise.resolve({id:"x"})});expect(r.status).toBe(401);});
});
