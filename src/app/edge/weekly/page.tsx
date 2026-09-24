import {randomUUID} from "node:crypto";
import Link from "next/link";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Shell} from "@/components/shell";
import {AccountSetup} from "@/components/account-setup";
import {WeeklyReviewPanel} from "@/components/weekly-review";
import {loadWeeklyReviewPanel} from "@/lib/weekly-review-data";
import {requireUser} from "@/lib/supabase/server";
import {previousCompletedWeek,weeklyPeriod} from "@/ai/weekly-period";
export const dynamic="force-dynamic";
export default async function WeeklyReviewPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const params=await searchParams,{db,user}=await requireUser();
 const q=await db.from("accounts").select("id,name").eq("user_id",user.id).order("created_at");
 if(q.error)throw new Error("Accounts unavailable");
 const accounts=z.array(z.object({id:z.uuid(),name:z.string()})).parse(q.data);
 const requested=typeof params.account==="string"?params.account:undefined,account=requested?accounts.find(a=>a.id===requested):accounts[0];
 if(requested&&!account)notFound();
 let period=previousCompletedWeek(),error:string|null=null;
 try{if(typeof params.week==="string")period=weeklyPeriod(params.week);}catch{error="Choose a valid calendar date. No review was requested.";}
 const page=typeof params.page==="string"&&/^\d{1,5}$/.test(params.page)?Number(params.page):0;
 const data=account&&!error?await loadWeeklyReviewPanel(account.id,period.startDate,page):null;
 return <Shell active="Edge" accountId={account?.id}><div className="page-heading"><div><p className="eyebrow">EDGE · OPTIONAL WEEKLY REFLECTION</p><h1>Review the week.</h1><p>Recorded process, bounded scope, preserved history.</p></div><Link className="pill" href={"/edge"+(account?"?account="+account.id:"")}>Back to EDGE</Link></div>
  {!account?<AccountSetup/>:<><nav className="account-tabs" aria-label="Weekly review account">{accounts.map(a=><Link key={a.id} className={a.id===account.id?"selected":""} href={"/edge/weekly?"+new URLSearchParams({account:a.id,week:period.startDate})}>{a.name}</Link>)}</nav>{error?<p role="alert" className="notice danger">{error} <Link href={"/edge/weekly?account="+account.id}>Return to the previous completed week</Link></p>:data&&<WeeklyReviewPanel key={account.id+period.startDate+page} data={data} requestKey={randomUUID()}/>}</>}
 </Shell>;
}
