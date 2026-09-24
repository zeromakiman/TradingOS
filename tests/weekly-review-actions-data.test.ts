import {beforeEach,describe,it,expect,vi} from "vitest";
import {ids,week,facts,weeklyOutput} from "./fixtures/weekly-review";
const m=vi.hoisted(()=>({review:vi.fn(),refresh:vi.fn(),owner:vi.fn(),facts:vi.fn(),availability:vi.fn(),queries:[] as {table:string;filters:[string,unknown][]}[],values:{} as Record<string,unknown>,errors:new Set<string>()}));
vi.mock("server-only",()=>({}));vi.mock("next/cache",()=>({revalidatePath:m.refresh}));vi.mock("next/navigation",()=>({unstable_rethrow:()=>{}}));
vi.mock("@/lib/weekly-review",()=>({reviewWeek:m.review}));
vi.mock("@/lib/weekly-review-source",()=>({ownedWeeklyAccount:m.owner,loadWeeklyFacts:m.facts,WeeklyScopeError:class extends Error{}}));
vi.mock("@/lib/ai-budget",()=>({accountAiAvailability:m.availability}));
import {requestWeeklyReview} from "@/app/weekly-review-actions";
import {loadWeeklyReviewPanel} from "@/lib/weekly-review-data";
beforeEach(()=>{
 vi.clearAllMocks();m.queries=[];m.errors.clear();m.values={weekly_ai_reviews:[],weekly_ai_review_results:[],ai_request_reservations:[],ai_usage_records:[]};m.availability.mockResolvedValue({status:"DISABLED",message:"AI analysis is currently disabled",deepEnabled:false});m.review.mockResolvedValue({status:"COMPLETED",message:"Saved"});m.facts.mockResolvedValue(facts);
 // biome-ignore lint/suspicious/noThenProperty: Supabase query double.
 const db={from:(table:string)=>{const q={table,filters:[] as [string,unknown][]};m.queries.push(q);const chain={select:()=>chain,eq:(k:string,v:unknown)=>{q.filters.push([k,v]);return chain;},in:(k:string,v:unknown)=>{q.filters.push([k,v]);return chain;},order:()=>chain,range:()=>chain,then:(resolve:(v:unknown)=>void)=>resolve({data:m.values[table],error:m.errors.has(table)?{}:null,count:11})};return chain;}};
 m.owner.mockResolvedValue({user:{id:ids.user},account:{id:ids.account,name:"Synthetic"},db});
});
const form=()=>{const f=new FormData();f.set("accountId",ids.account);f.set("week",week);f.set("requestKey",ids.review);return f;};
describe("weekly action and read-only history panel",()=>{
 it("accepts only owner account/date/key; ignores client costs, facts and permission",async()=>{const f=form();f.set("cost","0");f.set("facts","invented");f.set("permission","APPROVED");expect(await requestWeeklyReview({},f)).toEqual({success:"Saved"});expect(m.review).toHaveBeenCalledWith(ids.account,week,ids.review);expect(m.refresh.mock.calls).toEqual([["/edge/weekly"],["/settings"]]);});
 it.each(["COMPLETED","FAILED","RECORDED"])("%s is terminal for idempotency key rotation",async status=>{m.review.mockResolvedValue({status,message:"Recorded"});expect(await requestWeeklyReview({},form())).toEqual({success:"Recorded"});});
 it("budget failure stays an actionable error",async()=>{m.review.mockResolvedValue({status:"BUDGET_REACHED",message:"Insufficient budget"});expect(await requestWeeklyReview({},form())).toEqual({error:"Insufficient budget"});});
 it.each(["requestKey","accountId","week"])("malformed %s does not call service",async key=>{const f=form();f.set(key,"bad");expect(await requestWeeklyReview({},f)).toHaveProperty("error");expect(m.review).not.toHaveBeenCalled();});
 it("internal details are not exposed",async()=>{m.review.mockRejectedValue(new Error("private detail"));expect((await requestWeeklyReview({},form())).error).not.toContain("private detail");});
 it("AI OFF history is scoped to owner/account/week, with persisted cost; reading never calls the review service",async()=>{
  m.values.weekly_ai_reviews=[{id:ids.review,facts,operation:{provider:"openai",model:"gpt-6-astra",version:"WEEKLY_REVIEW_V1"},created_at:"2026-09-23T12:00Z",deadline_at:"2026-09-23T12:10Z"}];
  m.values.weekly_ai_review_results=[{review_id:ids.review,status:"COMPLETED",interpretation:weeklyOutput,error_code:null,reservation_id:ids.image,created_at:"2026-09-23T12:01Z"}];
  m.values.ai_request_reservations=[{id:ids.image,operation_id:ids.review,reserved_micros:792000}];m.values.ai_usage_records=[{reservation_id:ids.image,charged_micros:21000,disposition:"SETTLED"}];
  const result=await loadWeeklyReviewPanel(ids.account,week);expect(result).toMatchObject({amount:792000,availability:{status:"DISABLED"},hasOlder:true,error:null});expect(result.history[0].result?.interpretation).toEqual(weeklyOutput);expect(result.history[0].accounting?.usage?.charged_micros).toBe(21000);
  expect(m.queries[0].filters).toEqual([["account_id",ids.account],["user_id",ids.user],["week_start",week]]);expect(m.queries.find(q=>q.table==="ai_request_reservations")?.filters).toContainEqual(["operation","WEEKLY_REVIEW"]);expect(m.review).not.toHaveBeenCalled();
 });
 it("ownership denial is not converted into another account",async()=>{m.owner.mockRejectedValue(new Error("denied"));await expect(loadWeeklyReviewPanel(ids.image,week)).rejects.toThrow();expect(m.queries).toEqual([]);});
 it("history schema/migration failure disables only optional review",async()=>{m.errors.add("weekly_ai_reviews");const result=await loadWeeklyReviewPanel(ids.account,week);expect(result.error).toContain("history");expect(result.availability.status).toBe("CONFIGURATION_ERROR");});
 it("source failure preserves access to saved history",async()=>{m.facts.mockRejectedValue(new Error("unavailable"));const result=await loadWeeklyReviewPanel(ids.account,week);expect(result.scopeError).toContain("Nothing");expect(result.error).toBeNull();expect(result.facts).toBeNull();});
 it("invalid pagination is clamped",async()=>{expect((await loadWeeklyReviewPanel(ids.account,week,-2)).page).toBe(0);expect((await loadWeeklyReviewPanel(ids.account,week,10001)).page).toBe(10000);});
});
