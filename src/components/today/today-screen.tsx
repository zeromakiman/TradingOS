import { PageHeader } from "@/components/ui/page-header";
import { ClosedTodaySection } from "./closed-section";
import { TODAY_TITLE } from "./copy";
import { LiveTradesSection } from "./live-section";
import { NotesSection } from "./notes-section";
import { PlansWaitingSection } from "./plans-section";
import { SessionRibbon } from "./session-ribbon";
import { EmptyDay, NoActiveAccounts, Onboarding } from "./start-panels";
import { AccountStatusCard, AllAccountsStatus } from "./status-section";
import type { TodayPage, TodayView } from "./types";

/**
 * Today (docs/V2_ARCHITECTURE.md §14.1): the home workstation. In order of what a trader needs within seconds: the
 * strategy day and session ribbon, live positions (first, whenever one is open), whether trading is allowed and what
 * is left, plans waiting with their next step, today's closed trades, and today's plan · notes. Server-rendered from
 * `TodayPage`; only the clocks and the inline actions are client components.
 */

function Header({ view }: { view: TodayView }) {
  return (
    <PageHeader
      className="mb-0"
      eyebrow={view.dayLabel}
      title={TODAY_TITLE}
      description={
        <>
          {/* An account name of up to 100 characters wraps, even one without spaces, instead of widening the page. */}
          <span className="font-medium break-words text-1">{view.context.label}</span> · {view.context.detail}
          {/* The day is always the UTC−5 strategy day; say so when times are shown in another zone. */}
          {view.display.mode !== "strategy" && <span> · {view.zoneNote}</span>}
        </>
      }
    />
  );
}

function Workspace({ view }: { view: TodayView }) {
  const single = view.context.mode === "account" ? view.status[0] : undefined;
  return (
    <div className="flex flex-col gap-6">
      <Header view={view} />
      <SessionRibbon nowIso={view.now} />
      {view.live.length > 0 && (
        <LiveTradesSection trades={view.live} nowIso={view.now} showAccount={view.showAccount} truncated={view.liveTruncated} journalHref={view.liveJournalHref} />
      )}
      {single ? (
        <AccountStatusCard status={single} />
      ) : (
        view.summary && <AllAccountsStatus statuses={view.status} summary={view.summary} detail={view.context.detail} />
      )}
      {view.empty ? (
        <EmptyDay planHref={view.newTradeHrefs.plan} liveHref={view.newTradeHrefs.live} />
      ) : (
        <>
          <PlansWaitingSection plans={view.plans} showAccount={view.showAccount} />
          <ClosedTodaySection trades={view.closed} showAccount={view.showAccount} journalHref={view.closedJournalHref} truncated={view.closedTruncated} />
        </>
      )}
      <NotesSection notes={view.notes} />
      {/* Phones: keeps the end of the page clear of the live trades' quick-action dock. */}
      {view.live.length > 0 && <div aria-hidden="true" className="-mt-2 h-14 md:hidden" />}
    </div>
  );
}

export function TodayScreen({ page }: { page: TodayPage }) {
  switch (page.kind) {
    case "today":
      return <Workspace view={page.view} />;
    case "onboarding":
      return (
        <div className="flex flex-col gap-6">
          <PageHeader className="mb-0" eyebrow={page.dayLabel} title={TODAY_TITLE} description="Set up the trading account you trade on to start your day." />
          <Onboarding />
        </div>
      );
    case "no-active":
      return (
        <div className="flex flex-col gap-6">
          <PageHeader className="mb-0" eyebrow={page.dayLabel} title={TODAY_TITLE} />
          <NoActiveAccounts archivedCount={page.archivedCount} />
        </div>
      );
  }
}
