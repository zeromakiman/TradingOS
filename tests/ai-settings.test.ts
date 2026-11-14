import { beforeEach,describe,it,expect,vi } from "vitest";
// AI preference actions (src/app/ai-settings-actions.ts), used by V2 Settings → AI. The V1 AiSettings component tests
// that lived here moved with the component's V2 replacement: tests/v2-v1-replacements-ai-settings.test.ts (consent
// step, on/off, unavailable deployment) plus tests/v2-screen-settings.test.ts and tests/v2-ui-ai-components.test.ts
// (budget amounts, reset day and status chips). The real schema gate runs (src/lib/schema-gate.ts): it reads
// trading_os_schema() with the same session before anything is written (§13.10).
const mocks=vi.hoisted(()=>({user:vi.fn(),rpc:vi.fn(),system:vi.fn(),revalidate:vi.fn(),schema:{data:"2.1",error:null} as {data:unknown;error:unknown}}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({requireUser:mocks.user}));
vi.mock("@/lib/ai-budget",()=>({aiSystemAvailability:mocks.system}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
vi.mock("next/navigation",()=>({unstable_rethrow:()=>{}}));
import { saveAiActivation,saveAiBudget } from "@/app/ai-settings-actions";
import { SCHEMA_OUTDATED_MESSAGE } from "@/lib/schema-gate";
const accountId="11111111-1111-4111-8111-111111111111";
const SAVE="set_account_ai_preferences";
const ARCHIVED_SQL="ACCOUNT_ARCHIVED: This trading account is archived; restore it to add new trades or records";
const ARCHIVED_COPY="This trading account is archived. Restore it in Manage account to turn AI on or change its monthly limit.";
function form(fields:Record<string,string>){const f=new FormData();f.set("accountId",accountId);for(const [k,v] of Object.entries(fields))f.set(k,v);return f;}
let saveResult:{error:unknown}={error:null};
beforeEach(()=>{vi.clearAllMocks();mocks.schema={data:"2.1",error:null};saveResult={error:null};mocks.user.mockResolvedValue({db:{rpc:mocks.rpc},user:{id:"owner"}});mocks.rpc.mockImplementation(async(name:string)=>name==="trading_os_schema"?mocks.schema:saveResult);mocks.system.mockReturnValue({status:"ENABLED",message:"AI available",deepEnabled:true});});
describe("authenticated AI settings actions",()=>{
 it("requires explicit consent, with no write on unchecked disclosure",async()=>{expect(await saveAiActivation({},form({enabled:"true"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalledWith(SAVE,expect.anything());});
 it("does not activate when deployment is unavailable",async()=>{mocks.system.mockReturnValue({status:"DISABLED"});expect(await saveAiActivation({},form({enabled:"true",confirm:"on"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalledWith(SAVE,expect.anything());});
 it("confirmed activation uses the authenticated RPC and cannot silently raise budget",async()=>{expect(await saveAiActivation({},form({enabled:"true",confirm:"on",budget:"100"}))).toHaveProperty("success");expect(mocks.rpc).toHaveBeenCalledWith(SAVE,{p_account_id:accountId,p_enabled:true,p_budget_cents:null,p_confirm:true});});
 it("disabling always works while globally unavailable and preserves current cap",async()=>{mocks.system.mockReturnValue({status:"DISABLED"});expect(await saveAiActivation({},form({enabled:"false"}))).toHaveProperty("success");expect(mocks.rpc).toHaveBeenCalledWith(SAVE,expect.objectContaining({p_enabled:false,p_budget_cents:null}));});
 it("budget editing never changes opt-in even if a client submits enablement",async()=>{expect(await saveAiBudget({},form({budget:"3.25",enabled:"true",confirm:"on"}))).toHaveProperty("success");expect(mocks.rpc).toHaveBeenCalledWith(SAVE,expect.objectContaining({p_enabled:null,p_budget_cents:325}));});
 it.each(["0","100.01","1e2","", "-10"])("rejects invalid browser amount %s before RPC",async budget=>{expect(await saveAiBudget({},form({budget}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalledWith(SAVE,expect.anything());});
 it("signed-out request makes no mutation",async()=>{mocks.user.mockRejectedValue(new Error("session"));expect(await saveAiBudget({},form({budget:"5"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalled();});
 it("RLS ownership denial is contained in AI settings",async()=>{saveResult={error:{message:"Account not found"}};expect(await saveAiActivation({},form({enabled:"true",confirm:"on"}))).toEqual({error:"AI settings were not saved. Check account access and try again."});expect(mocks.revalidate).not.toHaveBeenCalled();});
});
describe("schema gate (§13.10)",()=>{
 // A V2 deployment pointed at a database without the V2 migrations writes nothing, as every V2 action.
 it.each([
  ["an older schema",{data:"1.4",error:null}],
  ["no schema marker (PostgREST)",{data:null,error:{code:"PGRST202",message:"Could not find the function public.trading_os_schema"}}],
  ["no schema marker (PostgreSQL)",{data:null,error:{code:"42883",message:"function public.trading_os_schema() does not exist"}}],
 ])("refuses every AI setting on %s, before any check or write",async(_label,schema)=>{
  mocks.schema=schema;
  for(const result of [await saveAiActivation({},form({enabled:"true",confirm:"on"})),await saveAiActivation({},form({enabled:"false"})),await saveAiBudget({},form({budget:"5"})),await saveAiBudget({},form({budget:"0"}))])expect(result).toEqual({error:SCHEMA_OUTDATED_MESSAGE});
  expect(mocks.rpc.mock.calls.map(([name])=>name)).toEqual(Array(4).fill("trading_os_schema"));
  expect(mocks.revalidate).not.toHaveBeenCalled();
 });
 it("reads the marker with the signed-in session, then writes with the same session",async()=>{expect(await saveAiBudget({},form({budget:"5"}))).toHaveProperty("success");expect(mocks.rpc.mock.calls.map(([name])=>name)).toEqual(["trading_os_schema",SAVE]);});
 it("does not write when the marker cannot be read",async()=>{mocks.schema={data:null,error:{code:"PGRST301",message:"timeout"}};expect(await saveAiBudget({},form({budget:"5"}))).toHaveProperty("error");expect(mocks.rpc).not.toHaveBeenCalledWith(SAVE,expect.anything());});
});
describe("archived trading accounts (§3.2, §11.2)",()=>{
 // The database takes only turning AI off on an archived account; turning AI on and a new limit wait for the restore.
 it.each([
  ["turning AI on",()=>saveAiActivation({},form({enabled:"true",confirm:"on"}))],
  ["a new monthly limit",()=>saveAiBudget({},form({budget:"10"}))],
 ])("says how to change %s when the account is archived",async(_label,run)=>{saveResult={error:{message:ARCHIVED_SQL}};expect(await run()).toEqual({error:ARCHIVED_COPY});expect(mocks.revalidate).not.toHaveBeenCalled();});
 it("turns AI off on an archived account like on any other",async()=>{expect(await saveAiActivation({},form({enabled:"false"}))).toEqual({success:"AI disabled for future requests. Existing evaluations and history are preserved."});expect(mocks.rpc).toHaveBeenCalledWith(SAVE,{p_account_id:accountId,p_enabled:false,p_budget_cents:null,p_confirm:false});expect(mocks.revalidate).toHaveBeenCalledWith("/settings");});
});
