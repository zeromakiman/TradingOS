import { beforeEach,describe,it,expect,vi } from "vitest";
// AI preference actions (src/app/ai-settings-actions.ts), used by V2 Settings → AI. The V1 AiSettings component tests
// that lived here moved with the component's V2 replacement: tests/v2-v1-replacements-ai-settings.test.ts (consent
// step, on/off, unavailable deployment) plus tests/v2-screen-settings.test.ts and tests/v2-ui-ai-components.test.ts
// (budget amounts, reset day and status chips).
const mocks=vi.hoisted(()=>({user:vi.fn(),rpc:vi.fn(),system:vi.fn(),revalidate:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({requireUser:mocks.user}));
vi.mock("@/lib/ai-budget",()=>({aiSystemAvailability:mocks.system}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
vi.mock("next/navigation",()=>({unstable_rethrow:()=>{}}));
import { saveAiActivation,saveAiBudget } from "@/app/ai-settings-actions";
const accountId="11111111-1111-4111-8111-111111111111";
function form(fields:Record<string,string>){const f=new FormData();f.set("accountId",accountId);for(const [k,v] of Object.entries(fields))f.set(k,v);return f;}
beforeEach(()=>{vi.clearAllMocks();mocks.user.mockResolvedValue({db:{rpc:mocks.rpc},user:{id:"owner"}});mocks.rpc.mockResolvedValue({error:null});mocks.system.mockReturnValue({status:"ENABLED",message:"AI available",deepEnabled:true});});
describe("authenticated AI settings actions",()=>{
 it("requires explicit consent, with no write on unchecked disclosure",async()=>{expect(await saveAiActivation({},form({enabled:"true"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalled();});
 it("does not activate when deployment is unavailable",async()=>{mocks.system.mockReturnValue({status:"DISABLED"});expect(await saveAiActivation({},form({enabled:"true",confirm:"on"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalled();});
 it("confirmed activation uses the authenticated RPC and cannot silently raise budget",async()=>{expect(await saveAiActivation({},form({enabled:"true",confirm:"on",budget:"100"}))).toHaveProperty("success");expect(mocks.rpc).toHaveBeenCalledWith("set_account_ai_preferences",{p_account_id:accountId,p_enabled:true,p_budget_cents:null,p_confirm:true});});
 it("disabling always works while globally unavailable and preserves current cap",async()=>{mocks.system.mockReturnValue({status:"DISABLED"});expect(await saveAiActivation({},form({enabled:"false"}))).toHaveProperty("success");expect(mocks.rpc).toHaveBeenCalledWith("set_account_ai_preferences",expect.objectContaining({p_enabled:false,p_budget_cents:null}));});
 it("budget editing never changes opt-in even if a client submits enablement",async()=>{expect(await saveAiBudget({},form({budget:"3.25",enabled:"true",confirm:"on"}))).toHaveProperty("success");expect(mocks.rpc).toHaveBeenCalledWith("set_account_ai_preferences",expect.objectContaining({p_enabled:null,p_budget_cents:325}));});
 it.each(["0","100.01","1e2","", "-10"])("rejects invalid browser amount %s before RPC",async budget=>{expect(await saveAiBudget({},form({budget}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalled();});
 it("signed-out request makes no mutation",async()=>{mocks.user.mockRejectedValue(new Error("session"));expect(await saveAiBudget({},form({budget:"5"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalled();});
 it("RLS ownership denial is contained in AI settings",async()=>{mocks.rpc.mockResolvedValue({error:{message:"Account not found"}});expect(await saveAiActivation({},form({enabled:"true",confirm:"on"}))).toHaveProperty("error");expect(mocks.revalidate).not.toHaveBeenCalled();});
});
