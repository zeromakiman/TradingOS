import {randomUUID} from "node:crypto";
import Link from "next/link";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Shell} from "@/components/shell";
import {AccountSetup} from "@/components/account-setup";
import {MonthlyReviewPanel} from "@/components/monthly-review";
import {loadMonthlyReviewPanel} from "@/lib/monthly-review-data";
import {requireUser} from "@/lib/supabase/server";
import {previousCompletedMonth,monthlyPeriod} from "@/ai/monthly-period";
export const dynamic="force-dynamic";
export default async function MonthlyReviewPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const params=await searchParams,{db,user}=await requireUser();
 const q=await db.from("accounts").select("id,name").eq("user_id",user.id).order("created_at");
 if(q.error)throw new Error("Accounts unavailable");
 const accounts=z.array(z.object({id:z.uuid(),name:z.string()})).parse(q.data);
 const requested=typeof params.account==="string"?params.account:undefined,account=requested?accounts.find(a=>a.id===requested):accounts[0];
 if(requested&&!account)notFound();
 let period=previousCompletedMonth(),error:string|null=null;
 try{if(params.month!==undefined)period=monthlyPeriod(z.string().parse(params.month));}catch{error="Choose a valid calendar month. No review was requested.";}
 const page=typeof params.page==="string"&&/^\d{1,5}$/.test(params.page)?Number(params.page):0;
 const data=account&&!error?await loadMonthlyReviewPanel(account.id,period.month,page):null;
 return <Shell active="Edge" accountId={account?.id}><div className="page-heading"><div><p className="eyebrow">EDGE · OPTIONAL MONTHLY REFLECTION</p><h1>Review the month.</h1><p>Recorded process, exact calendar boundaries, preserved history.</p></div><Link className="pill" href={"/edge"+(account?"?account="+account.id:"")}>Back to EDGE</Link></div>
 {!account?<AccountSetup/>:<><nav className="account-tabs" aria-label="Monthly review account">{accounts.map(a=><Link key={a.id} className={a.id===account.id?"selected":""} href={"/edge/monthly?"+new URLSearchParams({account:a.id,month:period.month})}>{a.name}</Link>)}</nav>{error?<p role="alert" className="notice danger">{error} <Link href={"/edge/monthly?account="+account.id}>Return to the previous completed month</Link></p>:data&&<MonthlyReviewPanel key={account.id+period.month+page} data={data} requestKey={randomUUID()}/>}</>}
 </Shell>;
}
