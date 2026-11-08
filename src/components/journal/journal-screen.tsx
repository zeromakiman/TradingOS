import { BookOpen, SearchX, Wallet } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DateDefinition } from "./date-definition";
import { FilterBar } from "./filter-bar";
import { ClearFiltersLink, JournalNavProvider, RefetchRegion } from "./journal-nav";
import { TradeList } from "./trade-list";
import type { EmptyView, JournalView } from "./types";

/**
 * Journal screen (docs/V2_ARCHITECTURE.md §14.5): a fast-scan list of every trade in the account context, grouped by
 * trade date, with URL-state filters and keyset pagination. Server-rendered from `JournalView`; only the filter
 * controls, the date definition and the links that clear filters are client components.
 */

const EMPTY_ICONS = { "no-accounts": Wallet, "no-trades": BookOpen, "no-matches": SearchX, "end-of-list": BookOpen } as const;

function Empty({ empty }: { empty: EmptyView }) {
  const Icon = EMPTY_ICONS[empty.kind];
  return (
    <EmptyState
      className="card"
      headingLevel={2}
      icon={<Icon />}
      title={empty.title}
      description={empty.description}
      actions={empty.actions.map(action =>
        action.clearsFilters ? (
          <ClearFiltersLink key={action.href + action.label} href={action.href} className={buttonClasses({ variant: action.variant })}>
            {action.label}
          </ClearFiltersLink>
        ) : (
          <Link key={action.href + action.label} href={action.href} prefetch={action.prefetch} className={buttonClasses({ variant: action.variant })}>
            {action.label}
          </Link>
        ),
      )}
    />
  );
}

export function JournalScreen({ view }: { view: JournalView }) {
  // Filters only help when there is something to filter (or a filter explains an empty list).
  const showFilters = view.empty === null || view.empty.kind === "no-matches" || view.empty.kind === "end-of-list";
  return (
    <JournalNavProvider>
      <div className="flex flex-col gap-5">
        <PageHeader
          className="mb-0"
          title="Journal"
          description={
            <>
              <span className="font-medium text-1">{view.contextLabel}</span> · Every trade and its decision history, newest first
            </>
          }
        />
        {showFilters && <FilterBar filters={view.filters} />}
        {view.notices.map(notice => (
          <Callout key={notice.text} tone={notice.tone} role={notice.tone === "negative" ? "alert" : "status"}>
            {notice.text}
          </Callout>
        ))}
        <RefetchRegion className="flex flex-col gap-4">
          <h2 className="sr-only">Trades</h2>
          {/* Announces the outcome of a filter change: the count, or the empty state's title. */}
          <p className="sr-only" aria-live="polite">
            {view.resultSummary ?? view.empty?.title}
          </p>
          {view.resultSummary && (
            <div className="-mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-3">
              <span aria-hidden="true">{view.resultSummary}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Times in {view.zoneLabel}</span>
                <DateDefinition definition={view.dateDefinition} note={view.dateNote} />
              </span>
            </div>
          )}
          {view.empty ? <Empty empty={view.empty} /> : <TradeList groups={view.groups} />}
          {view.pagination && (
            <Pagination
              label="Journal pages"
              summary={view.pagination.summary}
              previous={view.pagination.newerHref ? { href: view.pagination.newerHref, label: "Newer" } : view.pagination.newestHref ? { href: view.pagination.newestHref, label: "Newest" } : null}
              next={view.pagination.olderHref ? { href: view.pagination.olderHref, label: "Older" } : null}
            />
          )}
        </RefetchRegion>
      </div>
    </JournalNavProvider>
  );
}
