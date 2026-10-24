import { CircleAlert, CircleCheck, Hourglass, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { AiBudgetSummary, aiBudgetAmounts, aiBudgetStatus } from "@/components/ai/ai-budget-summary";
import { aiSettingsHref, dataToken, failureAccountingText } from "@/components/ai/model";
import { StaleNotice } from "@/components/ai/stale-revision-marker";
import { AiTechnicalFields } from "@/components/ai/technical";
import { StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { TechnicalDetails } from "@/components/ui/technical-details";
import type { TimeDisplay } from "@/domain/time-display";
import type { AiHistoryStatus } from "@/lib/ai-history";
import {
  BUDGET_TITLE, BUDGETS_TITLE, HISTORY_EMPTY_DESCRIPTION, HISTORY_EMPTY_TITLE, HISTORY_FILTERED_EMPTY_DESCRIPTION,
  HISTORY_FILTERED_EMPTY_TITLE, HISTORY_SOURCES, HISTORY_SOURCES_TITLE, HISTORY_TITLE, IN_PROGRESS_TEXT,
} from "./copy";
import type { HistoryEntryView } from "./history-model";
import { TAB_PATHS } from "./params";
import { AccountSelect, SegmentNav } from "./period-controls";
import { ReviewPendingRegion } from "./pending";
import type { HistoryContent } from "./review-data";
import { ACTION_LINK, REVIEW_COLUMNS } from "./styles";
import { TransitionLink, TransitionScope } from "./transition-link";

/**
 * History tab (docs/V2_ARCHITECTURE.md §11.1, §14.10): every AI analysis of the trader's accounts in compact rows,
 * `Weekly Review · Completed · 13:45`, with what it looked at (a period, or a trade that the row links to), the top
 * finding or the failure reason with its accounting outcome in plain words. Ids, versions, provider and accounting
 * details of the page's rows sit in one collapsed Technical details element under the list.
 */

const STATUS_ICONS: Readonly<Record<AiHistoryStatus, { icon: typeof CircleCheck; className: string }>> = {
  COMPLETED: { icon: CircleCheck, className: "text-pos" },
  FAILED: { icon: CircleAlert, className: "text-warn" },
  IN_PROGRESS: { icon: Hourglass, className: "text-accent" },
};

/**
 * Settings → AI lists every account's budget; a single account's link selects that account (§9.2). Links that switch
 * the context ("AI settings" of one account in All Accounts, "Show every account") are never prefetched, and
 * ReviewContextScope loads them in full so the header follows.
 */
const AI_SETTINGS_PATH = "/settings#ai";

function Subject({ entry, accountName }: { entry: HistoryEntryView; accountName: string | null }) {
  const { subject } = entry;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.8125rem] leading-5 text-2">
      {subject.href ? (
        <Link
          href={subject.href}
          // The text stays compact; the hit area reaches 40px (44px on touch) without growing the row (§13.5).
          className="relative font-medium text-accent after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] hover:underline pointer-coarse:after:-inset-y-3"
          // Trade links open the trade; period links open that period's review.
          aria-label={subject.kind === "trade" ? `${subject.label}, open trade` : `${subject.label}, open review`}
        >
          {subject.label}
        </Link>
      ) : (
        <span className="font-medium text-text">{subject.label}</span>
      )}
      {accountName && (
        <>
          <span aria-hidden="true">·</span>
          <span>{accountName}</span>
        </>
      )}
    </p>
  );
}

/** `Weekly Review · Completed · 13:45`: the compact row label of §11.1, in the trader's time display. */
function rowLabel(entry: HistoryEntryView): string {
  return `${entry.operationLabel} · ${entry.statusLabel}`;
}

function HistoryItem({ entry, accountName }: { entry: HistoryEntryView; accountName: string | null }) {
  const status = STATUS_ICONS[entry.status];
  const Icon = status.icon;
  return (
    <li className="flex gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0" data-status={dataToken(entry.status)}>
      <Icon aria-hidden="true" className={cx("mt-0.5 size-4 flex-none", status.className)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[0.875rem] leading-5">
          <span className="font-medium text-text">{rowLabel(entry)}</span>
          {entry.time && (
            <>
              <span className="text-2"> · </span>
              <time dateTime={entry.at} className="num text-2">
                {entry.time}
              </time>
            </>
          )}
        </p>
        <Subject entry={entry} accountName={accountName} />
        {entry.revision?.staleLabel && <StaleNotice text={entry.revision.staleLabel} className="self-start" />}
        {entry.status === "COMPLETED" && entry.headline && <p className="text-[0.8125rem] leading-5 text-text">{entry.headline}</p>}
        {entry.status === "FAILED" && (
          <div className="flex flex-col gap-0.5">
            {entry.failureReason && <p className="text-[0.8125rem] leading-5 text-text">{entry.failureReason}</p>}
            <p className="t-caption">{failureAccountingText(entry.technical)}</p>
          </div>
        )}
        {entry.status === "IN_PROGRESS" && <p className="t-meta">{IN_PROGRESS_TEXT}</p>}
      </div>
    </li>
  );
}

/**
 * Request ids, versions, provider, accounting and tokens of every row on this page, in one collapsed element at the end
 * of the list (§13.9): the rows stay scannable, and nothing technical is needed to read them.
 */
function HistoryTechnical({ content, developerMode }: { content: HistoryContent; developerMode: boolean }) {
  return (
    <TechnicalDetails developerMode={developerMode} className="mt-5">
      <ol className="flex flex-col gap-4">
        {content.groups.flatMap(group =>
          group.entries.map(entry => (
            <li key={entry.technical.requestId} className="flex flex-col gap-1">
              <p className="font-semibold">
                {group.label} · {rowLabel(entry)}
                {entry.time ? ` · ${entry.time}` : ""} · {entry.subject.label}
              </p>
              <AiTechnicalFields technical={entry.technical} status={entry.status} />
            </li>
          )),
        )}
      </ol>
    </TechnicalDetails>
  );
}

function HistoryList({ content, developerMode }: { content: HistoryContent; developerMode: boolean }) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-5">
        {content.groups.map(group => (
          <section key={group.key} aria-label={group.label} className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-3 uppercase">{group.label}</h3>
            <ol className="flex flex-col">
              {group.entries.map(entry => (
                <HistoryItem key={entry.technical.requestId} entry={entry} accountName={content.showAccount ? (content.accountNames[entry.accountId] ?? null) : null} />
              ))}
            </ol>
          </section>
        ))}
      </div>
      <HistoryTechnical content={content} developerMode={developerMode} />
    </div>
  );
}

function HistoryBody({ content, developerMode }: { content: HistoryContent; developerMode: boolean }) {
  if (content.error) return <Callout tone="warning">{content.error}</Callout>;
  if (content.groups.length === 0) {
    const filtered = content.filtered || content.newestHref !== null;
    return filtered ? (
      <EmptyState
        compact
        icon={<Sparkles />}
        title={HISTORY_FILTERED_EMPTY_TITLE}
        description={HISTORY_FILTERED_EMPTY_DESCRIPTION}
        actions={
          <TransitionLink href={content.clearHref} className={buttonClasses({ variant: "secondary" })}>
            Show every analysis
          </TransitionLink>
        }
      />
    ) : (
      <EmptyState
        compact
        icon={<Sparkles />}
        title={HISTORY_EMPTY_TITLE}
        description={HISTORY_EMPTY_DESCRIPTION}
        actions={
          <Link href={TAB_PATHS.weekly} className={buttonClasses({ variant: "secondary" })}>
            Open the weekly review
          </Link>
        }
      />
    );
  }
  return <HistoryList content={content} developerMode={developerMode} />;
}

function Budgets({ content, display, now }: { content: HistoryContent; display: TimeDisplay; now: Date }) {
  const headingId = useId();
  if (content.budgets.length === 0) return null;
  if (content.budgets.length === 1) {
    const [{ account, budget }] = content.budgets;
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <SectionHeader
          id={headingId}
          title={BUDGET_TITLE}
          className="mb-0"
          actions={
            <Link href={aiSettingsHref(account.id)} prefetch={false} className={ACTION_LINK}>
              <Settings aria-hidden="true" className="size-3.5" />
              AI settings
            </Link>
          }
        />
        <AiBudgetSummary accountName={account.name} budget={budget} timeDisplay={display} now={now} />
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <SectionHeader
        id={headingId}
        title={BUDGETS_TITLE}
        className="mb-0"
        actions={
          <Link href={AI_SETTINGS_PATH} className={ACTION_LINK}>
            <Settings aria-hidden="true" className="size-3.5" />
            AI settings
          </Link>
        }
      />
      <Card>
        <CardBody>
          <ul className="flex flex-col divide-y divide-border">
            {content.budgets.map(({ account, budget }) => {
              // The same status and amounts as AiBudgetSummary, laid out as one tidy row per account.
              const status = aiBudgetStatus(budget, now);
              return (
                <li key={account.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-text">{account.name}</span>
                    <StatusPill tone={status.tone} data-budget-status={status.label}>
                      {status.label}
                    </StatusPill>
                  </span>
                  <span className="t-meta num">
                    {budget.snapshot && budget.presentation ? aiBudgetAmounts(budget.snapshot, budget.presentation.remainingMicros) : "Usage unavailable"}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    </section>
  );
}

function Sources() {
  const headingId = useId();
  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle as="h2" id={headingId} className="text-[0.9375rem]">
          {HISTORY_SOURCES_TITLE}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <ul className="flex list-disc flex-col gap-2 pl-4 text-[0.8125rem] leading-5 text-2 marker:text-3">
          {HISTORY_SOURCES.map(point => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function HistoryView({ content, display, nowIso, developerMode }: { content: HistoryContent; display: TimeDisplay; nowIso: string; developerMode: boolean }) {
  const headingId = useId();
  const now = new Date(nowIso);
  const paged = content.newestHref !== null || content.olderHref !== null;
  return (
    <ReviewPendingRegion className={REVIEW_COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          {content.accountSelect && <AccountSelect model={content.accountSelect} className="sm:w-60" />}
          <SegmentNav label="Analyses" items={content.kinds} size="sm" />
        </div>
        {content.scopeNote && (
          <p className="t-meta">
            {content.scopeNote.text}{" "}
            <Link href={content.scopeNote.href} prefetch={false} className="font-medium text-accent hover:underline">
              {content.scopeNote.label}
            </Link>
          </p>
        )}
        <Card as="section" aria-labelledby={headingId}>
          <CardHeader>
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle as="h2" id={headingId}>
                {HISTORY_TITLE}
              </CardTitle>
              <CardDescription>{content.description}</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <HistoryBody content={content} developerMode={developerMode} />
          </CardBody>
        </Card>
        {paged && (
          // Paging keeps the current list visible, dimmed, until the next page arrives.
          <TransitionScope>
            <Pagination
              label="AI history pages"
              previous={content.newestHref ? { href: content.newestHref, label: "Newest" } : null}
              next={content.olderHref ? { href: content.olderHref, label: "Older" } : null}
              summary={`${content.count} ${content.count === 1 ? "analysis" : "analyses"} on this page`}
            />
          </TransitionScope>
        )}
      </div>
      <aside aria-label="AI budgets and sources" className="flex min-w-0 flex-col gap-6">
        <Budgets content={content} display={display} now={now} />
        <Sources />
      </aside>
    </ReviewPendingRegion>
  );
}
