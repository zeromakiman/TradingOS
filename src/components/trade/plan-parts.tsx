import { Info, OctagonAlert, ShieldCheck, ShieldX, TriangleAlert } from "lucide-react";
import { withKeys } from "@/components/ai/model";
import { Badge, StatusPill } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { Disclosure } from "@/components/ui/disclosure";
import type { ExplainedIssue } from "@/domain/risk-explain";
import type { TimeDisplay } from "@/domain/time-display";
import type { CheckView } from "@/lib/trades-data";
import { TRADE_COPY } from "./copy";
import { type PlanFact, whenLabel } from "./model";

/**
 * Building blocks of the Plan section (docs/V2_ARCHITECTURE.md §6.5, §14.4): a Risk Engine check with its exact
 * reasons (rendered from code + params by `explainReport`, BLOCK first, then warnings, notes collapsed), the plan's
 * values and the trader's own checks in words, and the thesis labelled Before entry. Server components.
 */

const ISSUE_STYLE = {
  negative: { box: "border-neg-border bg-neg-soft", divider: "divide-neg-border", title: "text-neg", icon: OctagonAlert },
  warning: { box: "border-warn-border bg-warn-soft", divider: "divide-warn-border", title: "text-warn", icon: TriangleAlert },
  neutral: { box: "border-border bg-surface", divider: "divide-border", title: "text-text", icon: Info },
} as const;

/** One tinted box per severity, one row per reason: the exact sentence under a short title. */
function IssueList({ issues, tone }: { issues: readonly ExplainedIssue[]; tone: keyof typeof ISSUE_STYLE }) {
  const styles = ISSUE_STYLE[tone];
  const Icon = styles.icon;
  return (
    <ul className={cx("flex flex-col divide-y rounded-control border", styles.box, styles.divider)} data-severity={tone}>
      {withKeys(issues, issue => issue.code).map(({ key, value: issue }) => (
        <li key={key} className="flex gap-2.5 px-3 py-2.5">
          <Icon aria-hidden="true" className={cx("mt-0.5 size-4 flex-none", styles.title)} />
          <div className="min-w-0">
            <p className={cx("text-[0.8125rem] font-semibold leading-5", styles.title)}>{issue.title}</p>
            <p className="text-text">{issue.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface RiskCheckViewProps {
  check: CheckView;
  now: string;
  display: TimeDisplay;
  /** "Risk check" for a draft's latest check, "Risk Engine at lock" for a locked plan. */
  label: string;
  /** An approval that is no longer current ("Recheck needed"). */
  stale?: boolean;
  /**
   * Whether a stale approval can be rechecked now; false on an archived account's draft, which takes no check until the
   * account is restored (its toolbar says so), so the note names no recheck. Default true.
   */
  recheckable?: boolean;
  /** Collapse warnings and notes (a locked plan's report is history, not a to-do list). */
  compact?: boolean;
  /** Words after the collapsed count: " at lock" for a locked plan's report. */
  findingsSuffix?: string;
}

export function RiskCheckView({ check, now, display, label, stale = false, recheckable = true, compact = false, findingsSuffix = " at lock" }: RiskCheckViewProps) {
  const { blocking, warnings, notes } = check.explained;
  const approved = check.decision === "APPROVED";
  const time = whenLabel(check.recordedAt, now, display);
  const findings = warnings.length + notes.length;
  return (
    <div className="flex flex-col gap-3" data-check={approved ? (stale ? "stale" : "approved") : "blocked"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusPill
          tone={approved ? (stale ? "warning" : "positive") : "danger"}
          icon={approved ? <ShieldCheck aria-hidden="true" className="size-3.5" /> : <ShieldX aria-hidden="true" className="size-3.5" />}
        >
          {approved ? (stale ? "Approved earlier" : "Approved") : "Blocked"}
        </StatusPill>
        <p className="t-meta num">
          {label} · {time}
          {check.revision !== null && ` · revision ${check.revision}`}
        </p>
      </div>
      {stale && (
        <p className="flex items-start gap-2 text-warn">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none" />
          <span>
            This approval is no longer current: the session, account values, risk plan or today's usage changed since {time}.
            {recheckable && " Recheck risk before locking."}
          </span>
        </p>
      )}
      {blocking.length > 0 && <IssueList issues={blocking} tone="negative" />}
      {approved && blocking.length === 0 && !compact && !stale && <p className="t-meta">Every hard rule passes for this revision.</p>}
      {compact ? (
        findings > 0 && (
          <Disclosure summary={`${findings === 1 ? "1 warning or note" : `${findings} warnings and notes`}${findingsSuffix}`}>
            <div className="flex flex-col gap-2 pt-1">
              {warnings.length > 0 && <IssueList issues={warnings} tone="warning" />}
              {notes.length > 0 && <IssueList issues={notes} tone="neutral" />}
            </div>
          </Disclosure>
        )
      ) : (
        <>
          {warnings.length > 0 && <IssueList issues={warnings} tone="warning" />}
          {notes.length > 0 && (
            <Disclosure summary={notes.length === 1 ? "1 note" : `${notes.length} notes`}>
              <div className="pt-1">
                <IssueList issues={notes} tone="neutral" />
              </div>
            </Disclosure>
          )}
        </>
      )}
    </div>
  );
}

/** Every stored check of the trade, newest first (each explained with its own risk plan and instrument versions). */
export function CheckHistory({ checks, now, display }: { checks: readonly CheckView[]; now: string; display: TimeDisplay }) {
  if (checks.length < 2) return null;
  const ordered = [...checks].reverse();
  return (
    <Disclosure summary={`Check history · ${checks.length} checks`}>
      <ol className="flex flex-col divide-y divide-border">
        {withKeys(ordered, check => check.recordedAt).map(({ key, value: check }) => {
          const reason = check.explained.blocking[0];
          return (
            <li key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
              <span className="t-caption num w-32 shrink-0">
                {whenLabel(check.recordedAt, now, display)}
                {check.revision !== null && ` · rev ${check.revision}`}
              </span>
              <span className={cx("font-medium", check.decision === "APPROVED" ? "text-pos" : "text-neg")}>{check.decision === "APPROVED" ? "Approved" : "Blocked"}</span>
              {reason && <span className="min-w-0 flex-1 text-text-2">{reason.detail}</span>}
            </li>
          );
        })}
      </ol>
    </Disclosure>
  );
}

/** Plan values as a definition grid; tabular figures keep prices aligned. */
export function PlanFactsList({ facts, label }: { facts: readonly PlanFact[]; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-x-6 gap-y-3 @md:grid-cols-3 @2xl:grid-cols-4">
      {facts.map(fact => (
        <div key={fact.label} className="min-w-0">
          <dt className="t-caption">{fact.label}</dt>
          <dd className={cx("num font-medium break-words", fact.tone === "warning" ? "text-warn" : "text-text")}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The trader's checks of the plan (news, contract values, strategy rules), each with its state in words. */
export function TraderChecks({ checks }: { checks: readonly PlanFact[] }) {
  if (!checks.length) return null;
  return (
    <ul aria-label="Checks recorded with the plan" className="flex flex-wrap gap-x-5 gap-y-1.5">
      {checks.map(check => (
        <li key={check.label} className="t-meta flex items-center gap-1.5">
          {check.tone === "warning" ? <TriangleAlert aria-hidden="true" className="size-3.5 text-warn" /> : <ShieldCheck aria-hidden="true" className="size-3.5 text-pos" />}
          <span>
            {check.label}: <span className={check.tone === "warning" ? "font-medium text-warn" : "font-medium text-text"}>{check.value}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The trade's thesis, labelled with its timing band: it was written before entry (§5.3). */
export function Thesis({ narrative, id, unavailable = false }: { narrative: string | null; id: string; unavailable?: boolean }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 id={id} className="text-sm font-semibold text-text">
          Thesis
        </h3>
        <Badge>{TRADE_COPY.thesisBand}</Badge>
      </div>
      {narrative?.trim() ? (
        <p className="whitespace-pre-wrap break-words border-l-2 border-border-strong pl-3 text-text">{narrative}</p>
      ) : (
        <p className="t-meta">{unavailable ? "The thesis couldn't be loaded right now. It is kept with the draft." : TRADE_COPY.noThesis}</p>
      )}
    </section>
  );
}
