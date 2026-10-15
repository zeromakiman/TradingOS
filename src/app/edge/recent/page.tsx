import {randomUUID} from "node:crypto";
import Link from "next/link";
import {notFound} from "next/navigation";
import {z} from "zod";
import {Shell} from "@/components/shell";
import {AccountSetup} from "@/components/account-setup";
import {RecentTradesPanel} from "@/components/recent-trades";
import {loadRecentTradesPanel} from "@/lib/recent-trades-data";
import {requireUser} from "@/lib/supabase/server";
import {recentSample} from "@/ai/recent-trades-context";
export const dynamic="force-dynamic";
export default async function RecentTradesPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const params=await searchParams,{db,user}=await requireUser();
 const q=await db.from("accounts").select("id,name").eq("user_id",user.id).order("created_at");
 if(q.error)throw new Error("Accounts unavailable");
 const accounts=z.array(z.object({id:z.uuid(),name:z.string()})).parse(q.data);
 const requestedAccount=typeof params.account==="string"?params.account:undefined,account=requestedAccount?accounts.find(a=>a.id===requestedAccount):accounts[0];
 if(requestedAccount&&!account)notFound();
 let requested:10|20|30=20,error:string|null=null;
 try{if(params.sample!==undefined)requested=recentSample(params.sample);}catch{error="Choose 10, 20 or 30 completed trades. No analysis was requested.";}
 const page=typeof params.page==="string"&&/^\d{1,5}$/.test(params.page)?Number(params.page):0;
 const data=account&&!error?await loadRecentTradesPanel(account.id,requested,page):null;
 return <Shell active="Edge" accountId={account?.id}><div className="page-heading"><div><p className="eyebrow">EDGE · OPTIONAL SAMPLE ANALYSIS</p><h1>Analyze recent trades.</h1><p>Recurring patterns across a precise sample, with preserved history.</p></div><Link className="pill" href={"/edge"+(account?"?account="+account.id:"")}>Back to EDGE</Link></div>
  {!account?<AccountSetup/>:<><nav className="account-tabs" aria-label="Recent-trades analysis account">{accounts.map(a=><Link key={a.id} className={a.id===account.id?"selected":""} href={"/edge/recent?"+new URLSearchParams({account:a.id,sample:String(requested)})}>{a.name}</Link>)}</nav>{error?<p role="alert" className="notice danger">{error} <Link href={"/edge/recent?account="+account.id}>Return to the default 20-trade sample</Link></p>:data&&<RecentTradesPanel key={account.id+requested+page} data={data} requestKey={randomUUID()}/>}</>}
 </Shell>;
}
