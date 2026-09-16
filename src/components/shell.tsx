import Link from "next/link";
import { Activity, ArrowUpRight, BookOpen, ChartNoAxesCombined, Crosshair, LayoutDashboard, LockKeyhole, Settings2 } from "lucide-react";
import { logout } from "@/app/actions";
const links = [
  { name: "Today", href: "/today", icon: LayoutDashboard },
  { name: "Analyze", href: "/analyze", icon: Crosshair },
  { name: "Journal", href: "/journal", icon: BookOpen },
  { name: "Edge", href: "/edge", icon: ChartNoAxesCombined },
  { name: "Settings", href: "/settings", icon: Settings2 }
];
export function Shell({ children, active, preview = false, accountId }: { children: React.ReactNode; active: string; preview?: boolean; accountId?: string }) {
  return <div className="workstation">
    <a className="skip-link" href="#main-content">Skip to main content</a><aside className="sidebar">
      <Link href={preview ? "/preview" : "/today"} className="brand"><span className="brand-mark"><Activity size={22}/></span><span>TRADING <b>OS</b><small>PRIVATE WORKSTATION</small></span></Link>
      <div className="workspace-label">WORKSPACE <span>01</span></div>
      <nav aria-label="Main navigation">{links.map(item => {
        const Icon = item.icon;
        return item.href ? <Link aria-current={active === item.name ? "page" : undefined} className={`nav-link ${active === item.name ? "active" : ""}`} key={item.name} href={preview ? item.name === "Analyze" ? "/preview" : "/login" : item.href + (accountId ? `?account=${accountId}` : "")}><Icon size={18}/>{item.name}{active === item.name && <span className="nav-dot"/>}</Link> : <span key={item.name} className="nav-link disabled" title="Planned after the deterministic foundation"><Icon size={18}/>{item.name}<small>Later</small></span>;
      })}</nav>
      <div className="sidebar-bottom"><div className="mode-card"><span className="dot"/>DEMO FORWARD TEST<small>Process before performance.</small></div><p><LockKeyhole size={13}/> No broker connection</p>{preview ? <Link href="/login">Private sign in <ArrowUpRight size={14}/></Link> : <form action={logout}><button type="submit" className="text-button">Sign out</button></form>}</div>
    </aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">WORKSPACE <span>/</span> <strong>{active.toUpperCase()}</strong></span><span className="topbar-right"><span className="dot"/> {preview ? "SYNTHETIC PREVIEW" : "DEMO ACCOUNT"}<i/>UTC−05:00</span></header><main id="main-content">{children}</main><footer className="footer"><span>Trading OS <span className="muted">/ Private workstation · 1.1</span></span><span>Written rules. Preserved evidence.</span></footer></div>
  </div>;
}

