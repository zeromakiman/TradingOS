import Link from "next/link";
import { Activity, Check, LockKeyhole } from "lucide-react";
import { redirect } from "next/navigation";
import { isConfigured, supabaseServer } from "@/lib/supabase/server";
import { login } from "@/app/actions";
import { ActionForm, Field } from "@/components/forms";
import { Button } from "@/components/ui/button";
export const dynamic = "force-dynamic";
export default async function LoginPage({searchParams}:{searchParams:Promise<{reason?:string}>}) {
  const {reason}=await searchParams;
  const configured = isConfigured();
  if (configured) { const db=await supabaseServer(); const {data}=await db.auth.getUser(); if(data.user) redirect("/today"); }
  return <main className="login-page"><div className="login-intro"><div className="brand"><span className="brand-mark"><Activity size={24}/></span><span>TRADING <b>OS</b></span></div><div className="eyebrow" style={{marginTop:40}}>YOUR PRIVATE TRADING WORKSTATION</div><h1>Make the process<br/>measurable.</h1><p>One place for your written strategy, deliberate risk decisions and the record of what you believed before a trade.</p><div className="login-principles"><span><Check size={16} className="success"/>ICT V1.0, preserved exactly</span><span><Check size={16} className="success"/>Risk checked with deterministic code</span><span><Check size={16} className="success"/>Original plans and history protected</span></div></div>
    <section className="panel login-panel"><div className="eyebrow"><LockKeyhole size={18}/></div><h2>{configured ? "Welcome back." : "Your foundation is ready."}</h2><p>{configured ? "Sign in to your private demo workspace." : "Connect your private Supabase project to enable sign-in and persistent records."}</p>
    {reason === "session" && <p className="notice" role="status">Your session expired or was invalid. Please sign in again.</p>}{reason === "signed_out" && <p className="notice" role="status">You are signed out.</p>}{configured ? <ActionForm action={login} label="Sign in" pendingLabel="Signing in…"><Field label="Email"><input name="email" type="email" required autoComplete="username"/></Field><Field label="Password"><input name="password" type="password" required autoComplete="current-password"/></Field></ActionForm> : <div className="notice"><p>Authentication and database access are awaiting configuration. You can explore the risk engine now using an isolated example.</p></div>}
    {reason === "password_updated" && <p className="notice success" role="status">Password updated. Sign in with your new password.</p>}{configured && <Link href="/forgot-password">Forgot password?</Link>}
    <Button asChild variant="outline" className="full-width"><Link href="/preview">Explore the risk engine →</Link></Button><div className="login-footnote">{configured ? "Access is invitation-only. Use the account provisioned in your private project." : "The repository includes the database migrations and a connection runbook in README.md."}<br/>Demo testing only · no broker execution connection.</div></section></main>;
}
