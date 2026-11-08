"use client";

import Decimal from "decimal.js";
import { CircleCheck, CircleDashed, OctagonAlert, RefreshCw, Settings2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { unstable_rethrow, useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { confirmAccountValuesUnchanged } from "@/app/actions/accounts";
import { type ActionState, idleState } from "@/app/actions/state";
import { manageHref } from "@/components/accounts/copy";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Disclosure } from "@/components/ui/disclosure";
import { useOptionalToast } from "@/components/ui/toast";
import { type DailyStatus, dailyStatusV2 } from "@/domain/daily-status";
import { formatMoney, formatMoneyExact } from "@/domain/format";
import type { ExplainedIssue } from "@/domain/risk-explain";
import { GAP_COPY, NEW_DAY_BODY, NEW_DAY_TITLE, PREVIEW_TITLE, UNREACHABLE_COPY } from "./copy";
import { listInputs, type PlanField, type PlanPreview, type PreviewStats, previewSummary, REASON_FIELDS } from "./plan-model";
import type { FormAccount } from "./types";

/**
 * The live deterministic preview of Plan Trade and Edit Draft (docs/V2_ARCHITECTURE.md §6.5–6.6, §14.2): the verdict in
 * words, every blocking reason with its exact sentence (BLOCK first, in engine order), size, money at risk, planned RR
 * and stop distance formatted so no rounding contradicts the verdict, warnings and notes collapsed. A reason a field can
 * fix offers a button that moves focus to that field; stale account values can be confirmed right here.
 */

export type FixTarget = PlanField | "contract" | "contradiction" | "news";

export interface RiskPreviewProps {
  preview: PlanPreview;
  account: FormAccount | null;
  /** Server-anchored time of the preview (today's limits line). */
  now: string;
  onFix?: (target: FixTarget) => void;
  onReload?: () => void;
  /** Overrides the account-values action (tests and demos). */
  confirmValues?: typeof confirmAccountValuesUnchanged;
  /** The card's last row (the form's desktop save), rendered as a direct child so it can stick to the window's edge. */
  footer?: ReactNode;
  className?: string;
}

const SUMMARY_TONE = { positive: "positive", negative: "negative", neutral: "neutral", warning: "warning" } as const;

/** The verdict in words with its icon (never colour alone). */
export function VerdictPill({ preview }: { preview: PlanPreview }) {
  const summary = previewSummary(preview);
  const icon = summary.tone === "positive" ? <CircleCheck aria-hidden="true" className="size-3.5" />
    : summary.tone === "negative" ? <OctagonAlert aria-hidden="true" className="size-3.5" />
      : summary.tone === "warning" ? <TriangleAlert aria-hidden="true" className="size-3.5" />
        : <CircleDashed aria-hidden="true" className="size-3.5" />;
  return (
    <StatusPill tone={SUMMARY_TONE[summary.tone]} icon={icon} className="shrink-0">
      {summary.label}
    </StatusPill>
  );
}

type Tone = "block" | "warn" | "note";

function Reason({ issue, tone, onFix, action }: { issue: ExplainedIssue; tone: Tone; onFix?: (target: FixTarget) => void; action?: ReactNode }) {
  const fix = tone !== "note" ? REASON_FIELDS[issue.code] : undefined;
  const Icon = tone === "block" ? OctagonAlert : TriangleAlert;
  return (
    <li className="flex gap-2.5">
      {tone === "note" ? (
        <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-text-3" />
      ) : (
        <Icon aria-hidden="true" className={cx("mt-0.5 size-4 shrink-0", tone === "block" ? "text-neg" : "text-warn")} />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text">{issue.title}</p>
        <p className="t-meta">{issue.detail}</p>
        {fix && onFix && (
          <Button type="button" variant="link" size="sm" className="mt-1" onClick={() => onFix(fix.field)}>
            {fix.label}
          </Button>
        )}
        {action}
      </div>
    </li>
  );
}

function ReasonList({ issues, tone, onFix, label, actionFor }: {
  issues: ExplainedIssue[]; tone: Tone; onFix?: (target: FixTarget) => void; label: string; actionFor?: (issue: ExplainedIssue) => ReactNode;
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {issues.map(issue => (
        <Reason key={`${issue.code}-${issue.detail}`} issue={issue} tone={tone} onFix={onFix} action={actionFor?.(issue)} />
      ))}
    </ul>
  );
}

/** `2 warnings · 1 note`: the summary of the collapsed findings (spec §6.5 collapses warnings and notes by default). */
export function findingsSummary(warnings: number, notes: number): string {
  const parts = [
    warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null,
    notes ? `${notes} ${notes === 1 ? "note" : "notes"}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function Collapsed({ warnings, notes, onFix }: { warnings: ExplainedIssue[]; notes: ExplainedIssue[]; onFix?: (target: FixTarget) => void }) {
  if (!warnings.length && !notes.length) return null;
  return (
    <Disclosure summary={findingsSummary(warnings.length, notes.length)} className="bg-surface-sunken" bodyClassName="flex flex-col gap-3">
      {warnings.length > 0 && <ReasonList issues={warnings} tone="warn" onFix={onFix} label="Warnings" />}
      {notes.length > 0 && <ReasonList issues={notes} tone="note" label="Notes" />}
    </Disclosure>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="t-caption">{label}</dt>
      <dd className="num min-w-0 font-semibold text-text">
        {value}
        {detail && <span className="t-caption block font-normal">{detail}</span>}
      </dd>
    </div>
  );
}

const RR_CLASS = { pass: undefined, warn: "text-warn", block: "text-neg" } as const;

function Stats({ stats }: { stats: PreviewStats | null }) {
  const blank = <span className="text-text-3">—</span>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-control border border-border bg-surface-sunken p-3">
      <Stat label="Position size" value={stats ? stats.quantity : blank} detail={stats?.unit} />
      <Stat label="Risk at stop" value={stats ? stats.risk : blank} detail={stats ? `${stats.riskOfEquity} of equity` : undefined} />
      <Stat
        label="Planned RR"
        value={stats ? <span className={RR_CLASS[stats.rrState]}>{stats.rr}</span> : blank}
        detail={stats ? `${stats.rrState === "pass" ? "Meets" : "Below"} the ${stats.minRR} minimum` : undefined}
      />
      <Stat label="Stop distance" value={stats ? stats.stopDistance : blank} />
      <Stat label="Reward at target" value={stats ? stats.reward : blank} />
      <Stat label="Risk budget" value={stats ? stats.budget : blank} detail={stats ? `${stats.requestedRisk} requested` : undefined} />
    </dl>
  );
}

function todayStatus(account: FormAccount | null, now: string): DailyStatus | null {
  if (!account?.risk) return null;
  try {
    return dailyStatusV2({ now, observationDay: account.risk.observationDay, currency: account.currency, plan: account.risk.plan }, account.risk.usage);
  } catch {
    return null;
  }
}

/** `FTMO 100K · Risk Plan V1.2 · 1 of 2 trades left today · $1,500.00 daily risk left`. */
export function contextLine(account: FormAccount | null, now: string): string | null {
  if (!account) return null;
  const parts = [account.name, account.riskPlan?.version ?? null];
  const status = todayStatus(account, now);
  if (status && !status.stale) {
    const left = status.stats.risk.left;
    parts.push(
      `${status.stats.trades.label} trades left today`,
      // Remaining risk rounds down: the line never promises more room than the engine allows.
      left === null ? "no daily risk cap" : `${formatMoneyExact(new Decimal(left).toDecimalPlaces(2, Decimal.ROUND_FLOOR).toFixed(), account.currency)} daily risk left`,
    );
  }
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/** `Balance $100,000.00 · equity $99,500.00`: the values "Confirm unchanged" records again for today. */
export function lastValuesText(account: Pick<FormAccount, "balance" | "equity" | "currency">): string | null {
  if (account.balance === null || account.equity === null) return null;
  return `Balance ${formatMoney(account.balance, account.currency)} · equity ${formatMoney(account.equity, account.currency)}`;
}

/**
 * STALE_EQUITY quick fix: the last recorded values with "Confirm unchanged" (records them again for today, refused when
 * newer values exist) and a link to update them. The page then reloads its account data; the form keeps its entries.
 */
function AccountValuesFix({ account, confirmValues }: { account: FormAccount; confirmValues: typeof confirmAccountValuesUnchanged }) {
  const router = useRouter();
  const toast = useOptionalToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const values = lastValuesText(account);
  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("accountId", account.id);
      if (account.observationId) form.set("observationId", account.observationId);
      let result: ActionState;
      try {
        result = await confirmValues(idleState, form);
      } catch (failure) {
        unstable_rethrow(failure);
        result = { status: "error", message: UNREACHABLE_COPY };
      }
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      toast?.toast({ title: result.status === "success" && result.message ? result.message : "Balance confirmed for today.", tone: "positive" });
      router.refresh();
    });
  };
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-control border border-border bg-surface-sunken p-2.5">
      {values && <p className="t-caption num">{values}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {values && (
          <Button type="button" size="sm" variant="secondary" loading={pending} loadingText="Confirming…" onClick={confirm}>
            Confirm unchanged
          </Button>
        )}
        <Link href={manageHref(account.id, "account-values")} className="btn btn-link btn-sm">
          Update values
        </Link>
      </div>
      {error && (
        <p role="alert" className="field-error">
          <OctagonAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

function Unavailable({ account, gaps }: { account: FormAccount | null; gaps: PlanPreview & { kind: "unavailable" } }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="What this account needs">
      {gaps.gaps.map(gap => {
        const copy = GAP_COPY[gap];
        return (
          <li key={gap} className="flex gap-2.5">
            <Settings2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="min-w-0">
              <p className="t-meta text-text">{copy.text}</p>
              {copy.tab && copy.action && account && (
                <Link href={manageHref(account.id, copy.tab)} className="btn btn-link btn-sm mt-1">
                  {copy.action}
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** What screen readers hear when the verdict changes: the verdict and its first reason, not every number. */
export function previewAnnouncement(preview: PlanPreview): string {
  const summary = previewSummary(preview);
  return summary.tone === "positive" ? `${PREVIEW_TITLE}: ${summary.label}.` : `${PREVIEW_TITLE}: ${summary.label}. ${summary.detail}.`;
}

export function RiskPreview({ preview, account, now, onFix, onReload, confirmValues = confirmAccountValuesUnchanged, footer, className }: RiskPreviewProps) {
  const line = contextLine(account, now);
  const actionFor = (issue: ExplainedIssue) => (issue.code === "STALE_EQUITY" && account && onFix ? <AccountValuesFix account={account} confirmValues={confirmValues} /> : null);
  return (
    <section aria-labelledby="risk-preview-title" id="risk-preview" className={cx("card flex scroll-mt-20 flex-col", className)}>
      <div className="flex shrink-0 items-start justify-between gap-3 border-border border-b px-4 py-3">
        <div className="min-w-0">
          <h2 id="risk-preview-title" className="font-semibold text-text">
            {PREVIEW_TITLE}
          </h2>
          {/* Starts with the account's name (up to 100 characters, maybe without spaces): it breaks, never widens the card. */}
          {line && <p className="t-caption mt-0.5 wrap-anywhere">{line}</p>}
        </div>
        <VerdictPill preview={preview} />
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {previewAnnouncement(preview)}
      </p>
      {/* On desktop the aside is sticky and at most one window tall: the body scrolls when there are many reasons. */}
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-b-card p-4">
        {preview.kind === "no-account" && <p className="t-meta">Choose a trading account to see its risk check.</p>}
        {preview.kind === "unavailable" && <Unavailable account={account} gaps={preview} />}
        {preview.kind === "new-day" && (
          <Callout
            tone="warning"
            title={NEW_DAY_TITLE}
            action={onReload && (
              <Button type="button" size="sm" variant="secondary" icon={<RefreshCw aria-hidden="true" />} onClick={onReload}>
                Reload
              </Button>
            )}
          >
            {NEW_DAY_BODY}
          </Callout>
        )}
        {preview.kind === "incomplete" && (
          <>
            {preview.blockers.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="t-meta font-medium text-text">Blocked right now, whatever the plan:</p>
                <ReasonList issues={preview.blockers} tone="block" label="Blocking reasons" actionFor={actionFor} />
              </div>
            )}
            <p className="t-meta">Add the {listInputs(preview.missing)} to see the size, risk and RR.</p>
            <Stats stats={null} />
          </>
        )}
        {preview.kind === "report" && (
          <>
            <p className={cx("t-meta", preview.decision === "APPROVED" ? "text-pos" : "text-text")}>
              {preview.decision === "APPROVED"
                ? "Every rule passes. Save the draft, then lock the plan from the trade page."
                : `Saving keeps it as a draft. It can't be locked until ${preview.blocking.length === 1 ? "this is" : "these are"} resolved:`}
            </p>
            {preview.blocking.length > 0 && <ReasonList issues={preview.blocking} tone="block" onFix={onFix} label="Blocking reasons" actionFor={actionFor} />}
            <Stats stats={preview.stats} />
            {preview.thesisMissing && <p className="t-meta">Add your thesis to save the draft.</p>}
            <Collapsed warnings={preview.warnings} notes={preview.notes} onFix={onFix} />
          </>
        )}
      </div>
      {footer}
    </section>
  );
}
