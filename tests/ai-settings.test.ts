import { beforeEach,describe,it,expect,vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const mocks=vi.hoisted(()=>({user:vi.fn(),rpc:vi.fn(),system:vi.fn(),revalidate:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({requireUser:mocks.user}));
vi.mock("@/lib/ai-budget",()=>({aiSystemAvailability:mocks.system}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
vi.mock("next/navigation",()=>({unstable_rethrow:()=>{},useRouter:()=>({push:vi.fn(),refresh:vi.fn()})}));
import { saveAiActivation,saveAiBudget } from "@/app/ai-settings-actions";
import { AiSettings } from "@/components/ai-settings";
import { budgetPresentation, type BudgetSnapshot } from "@/ai/budget";
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
describe("Opus Settings AI section",()=>{
 const base:BudgetSnapshot={enabled:false,budgetCents:500,usedMicros:1340000,heldMicros:0,uncertain:false,period:"2026-09-01",resetAt:"2026-10-01T05:00:00Z"};
 function render(b=base,available=true){return renderToStaticMarkup(createElement(AiSettings,{accountId,data:{snapshot:b,presentation:budgetPresentation(b,available),system:{status:available?"ENABLED":"DISABLED",message:available?"AI available":"AI analysis is currently disabled",deepEnabled:available},events:[],reservationMicros:1056000,error:null}}));}
 it("shows OFF, costs, remaining, exact fixed-offset reset and clear advisory copy",()=>{const html=render();for(const text of ["OFF","€5.00","€1.34","€3.66","26% committed","2026-10-01 00:00 UTC−5","AI is advisory","not the provider","1.056"])expect(html).toContain(text);});
 it("activation requires opening a separate disclosure and checking an unchecked confirmation",()=>{const html=render();expect(html).toContain("Enable AI for this account…");expect(html).toContain("Confirm and enable AI");expect(html).toContain("selected screenshots");const checkbox=html.match(/<input[^>]*name="confirm"[^>]*>/)?.[0];expect(checkbox).toContain('type="checkbox"');expect(checkbox).toContain('required=""');expect(checkbox).not.toContain('checked=""');});
 it("ON provides deactivation, not another opt-in",()=>{const html=render({...base,enabled:true});expect(html).toContain("Disable AI");expect(html).not.toContain("Confirm and enable AI");});
 it("global UNAVAILABLE cannot offer activation while budget editing remains usable",()=>{const html=render(base,false);expect(html).toContain("UNAVAILABLE");expect(html).not.toContain("Confirm and enable AI");expect(html).toContain("Save monthly AI budget");});
 it("BUDGET REACHED and threshold warnings use text as well as progress",()=>{const html=render({...base,enabled:true,usedMicros:5000000});expect(html).toContain("BUDGET REACHED");expect(html).toContain("Limit reached");expect(html).toContain("100% committed");expect(html).toContain("AI monthly budget committed");});
 it("uncertainty is unavailable even when unused capacity remains",()=>{const html=render({...base,enabled:true,uncertain:true});expect(html).toContain("Accounting review required");expect(html).toContain("Disable AI");});
});
