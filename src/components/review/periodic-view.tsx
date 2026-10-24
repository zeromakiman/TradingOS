import { ArrowRight, CircleCheck, CircleMinus, CircleSlash, Hourglass, Settings } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { AiBudgetSummary } from "@/components/ai/ai-budget-summary";
import { aiSettingsHref } from "@/components/ai/model";
import { PeriodicReviewPanel } from "@/components/ai/periodic-review-panel";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { SectionHeader } from "@/components/ui/page-header";
import type { TimeDisplay } from "@/domain/time-display";
import { BUDGET_TITLE, FACTS_UNAVAILABLE } from "./copy";
import { AccountSelect, PeriodControlView } from "./period-controls";
import { ReviewPendingRegion } from "./pending";
import type { FactRow, PeriodFactsModel, PeriodicContent } from "./review-data";
import { ACTION_LINK, INLINE_ACTION_LINK, REVIEW_COLUMNS } from "./styles";

/**
 * One periodic tab (Weekly, Recent trades, Monthly; docs/V2_ARCHITECTURE.md §11.1–11.2, §11.5, §14.10): the scope
 * (account, period, and what Trading OS recorded for it), the AI review panel with its run button and estimate, the
 * account's AI budget and how the review works. Nothing here requests AI; only the panel's button does, on click.
 */

const FACT_ICONS: Readonly<Record<FactRow["tone"], { icon: typeof CircleCheck; className: string }>> = {
  included: { icon: CircleCheck, className: "text-2" },
  excluded: { icon: CircleMinus, className: "text-3" },
  neutral: { icon: CircleSlash, className: "text-3" },
  pending: { icon: Hourglass, className: "text-3" },
};

/**
 * Deterministic counts of the period: what the review covers and what it leaves out (live-first, imported), or, while
 * the period runs, what closed so far. The Journal link sits beside the heading, so the run button below stays within
 * the first screen on a phone. In All Accounts it switches the context to the reviewed account (ReviewContextScope
 * loads it in full).
 */
export function PeriodFacts({ facts }: { facts: PeriodFactsModel }) {
  const headingId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2" data-zone="trading-os">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p id={headingId} className="text-xs font-semibold text-2">
          {facts.heading}
        </p>
        {facts.journal && (
          <Link
            href={facts.journal.href}
            // A link that switches the account context must not be prefetched (§9.2).
            prefetch={facts.journal.switchesContext ? false : undefined}
            aria-label={facts.journal.description}
            className={INLINE_ACTION_LINK}
          >
            {facts.journal.label}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        )}
      </div>
      <ul aria-labelledby={headingId} className="flex flex-col gap-1">
        {facts.rows.map(row => {
          const { icon: Icon, className } = FACT_ICONS[row.tone];
          return (
            <li key={row.label} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5" data-tone={row.tone}>
              <span className="num text-base font-semibold text-text">{row.value}</span>
              <span className="text-text">{row.label}</span>
              <span className="inline-flex items-center gap-1 self-center text-[0.8125rem] text-2">
                <Icon aria-hidden="true" className={cx("size-3.5 flex-none", className)} />
                {row.note}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Account and period, then what Trading OS recorded for that period: beside the pickers when the card is wide enough
 * for both (a container query, so it follows the card rather than the window), below them otherwise.
 */
function ScopeCard({ content }: { content: PeriodicContent }) {
  return (
    <section aria-label="Review scope" className="card @container">
      <div className="card-body grid items-start gap-4 @min-[46rem]:grid-cols-[auto_minmax(0,1fr)] @min-[46rem]:gap-6">
        <div className="flex min-w-0 flex-col gap-3">
          {content.accountSelect && <AccountSelect model={content.accountSelect} className="@min-[30rem]:w-[24rem]" />}
          <PeriodControlView control={content.period} className={content.period.kind === "picker" ? "@min-[30rem]:w-[24rem]" : undefined} />
        </div>
        <div className="min-w-0 border-t border-border pt-3 @min-[46rem]:border-t-0 @min-[46rem]:border-l @min-[46rem]:pt-0 @min-[46rem]:pl-6">
          {content.facts ? <PeriodFacts facts={content.facts} /> : <p className="t-meta">{FACTS_UNAVAILABLE}</p>}
        </div>
      </div>
    </section>
  );
}

function BudgetSection({ content, display, now }: { content: PeriodicContent; display: TimeDisplay; now: Date }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <SectionHeader
        id={headingId}
        title={BUDGET_TITLE}
        className="mb-0"
        actions={
          <Link
            href={aiSettingsHref(content.account.id)}
            // The link selects this account in Settings (§9.2), so it is never prefetched; in All Accounts it switches the
            // context and ReviewContextScope loads it in full.
            prefetch={false}
            className={ACTION_LINK}
          >
            <Settings aria-hidden="true" className="size-3.5" />
            AI settings
          </Link>
        }
      />
      <AiBudgetSummary accountName={content.account.name} budget={content.budget} timeDisplay={display} now={now} />
    </section>
  );
}

function Explainer({ title, points }: PeriodicContent["explainer"]) {
  const headingId = useId();
  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle as="h2" id={headingId} className="text-[0.9375rem]">
          {title}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <ul className="flex list-disc flex-col gap-2 pl-4 text-[0.8125rem] leading-5 text-2 marker:text-3">
          {points.map(point => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function PeriodicView({ content, display, nowIso, developerMode }: { content: PeriodicContent; display: TimeDisplay; nowIso: string; developerMode: boolean }) {
  const now = new Date(nowIso);
  return (
    <ReviewPendingRegion className={REVIEW_COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4">
        <ScopeCard content={content} />
        <Card>
          <CardBody>
            <PeriodicReviewPanel kind={content.panel.kind} accountId={content.panel.accountId} period={content.panel.period} developerMode={developerMode} />
          </CardBody>
        </Card>
      </div>
      <aside aria-label="AI budget and how it works" className="flex min-w-0 flex-col gap-6">
        <BudgetSection content={content} display={display} now={now} />
        <Explainer title={content.explainer.title} points={content.explainer.points} />
      </aside>
    </ReviewPendingRegion>
  );
}
