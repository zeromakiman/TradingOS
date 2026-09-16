import { Activity, CircleAlert, ShieldCheck } from "lucide-react";

type Tier = "clear" | "working" | "restricted";
/** `tone` is a presentation class only; callers derive it from authoritative formatted output. */
export type Readout = { label: string; value: string; tone?: "success" | "red" | "muted" | "amber" };

/** Presentation tier only. Derived from the authoritative dailyStatus output; no rule is re-evaluated here. */
export function statusTier(label: string, reasons: string[]): Tier {
  if (reasons.length) return "restricted";
  return label === "PLAN ACTIVE" || label === "TRADE ACTIVE" ? "working" : "clear";
}

const tierCopy = {
  clear: "NEW PLANS PERMITTED",
  working: "NEW PLANS PERMITTED · WORK IN PROGRESS",
  restricted: "NEW LOCKS RESTRICTED"
} as const;

export function StatusBanner({ label, reasons, clock, note, readout, action }: {
  label: string;
  reasons: string[];
  clock: string;
  note: string;
  readout: Readout[];
  action?: React.ReactNode;
}) {
  const tier = statusTier(label, reasons), Icon = tier === "restricted" ? CircleAlert : tier === "working" ? Activity : ShieldCheck;
  return <section className={`status-banner is-${tier}`}>
    <div>
      <div className="tier"><Icon size={14} aria-hidden="true"/>{tierCopy[tier]}{tier === "restricted" ? ` · ${reasons.length} CONDITION${reasons.length === 1 ? "" : "S"}` : ""}</div>
      <h2>{label}</h2>
      <div className="clock">{clock}</div>
      {reasons.length > 0 && <ul className="status-reasons">{reasons.map(reason => <li key={reason}><CircleAlert size={15} className="red" aria-hidden="true"/><span>{reason}</span></li>)}</ul>}
      <p className="status-note">{note}</p>
    </div>
    <div className="status-readout">{readout.map(r => <span key={r.label}><b>{r.label}</b><i className={r.tone}>{r.value}</i></span>)}</div>
    {action && <div className="status-banner-action">{action}</div>}
  </section>;
}
