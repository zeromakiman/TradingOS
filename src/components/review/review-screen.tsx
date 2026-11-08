import { Landmark } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { TabLinks } from "@/components/ui/tab-links";
import { AccountChooser } from "./account-chooser";
import { ReviewContextScope } from "./context-scope";
import { NO_ACCOUNTS_DESCRIPTION, NO_ACCOUNTS_TITLE, REVIEW_DESCRIPTION, REVIEW_TABS_LABEL, REVIEW_TITLE } from "./copy";
import { HistoryView } from "./history-view";
import { ReviewTransition } from "./pending";
import { PeriodicView } from "./periodic-view";
import type { ReviewView } from "./review-data";
import { TAB_STRIP } from "./styles";
import { ReviewTabLabel } from "./tab-label";
import { ReviewTabStrip } from "./tab-strip";

/**
 * Review workspace (docs/V2_ARCHITECTURE.md §14.10): tabs Weekly · Recent trades · Monthly · History, each a URL. The
 * periodic tabs review one trading account at a time with the AI review panel (run button with its estimate, concise
 * card, period history) beside the account's AI budget; History lists every AI analysis across the trader's accounts.
 * Server rendered; the account and period pickers are small client islands, and no AI request is ever sent on load.
 * Links that switch the trading-account context load their page in full, so the header always names the context the
 * next page shows (ReviewContextScope, §9.2).
 */

function Notices({ notices }: { notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {notices.map(notice => (
        <Callout key={notice} tone="warning" role="status">
          {notice}
        </Callout>
      ))}
    </div>
  );
}

function NoAccounts() {
  return (
    <EmptyState
      icon={<Landmark />}
      headingLevel={2}
      title={NO_ACCOUNTS_TITLE}
      description={NO_ACCOUNTS_DESCRIPTION}
      actions={
        <Link href="/accounts/new" className={buttonClasses({ variant: "primary" })}>
          Create trading account
        </Link>
      }
    />
  );
}

function Content({ view }: { view: ReviewView }) {
  const { content } = view;
  switch (content.kind) {
    case "no-accounts":
      return <NoAccounts />;
    case "choose":
      return <AccountChooser content={content} />;
    case "periodic":
      return <PeriodicView content={content} display={view.display} nowIso={view.nowIso} developerMode={view.developerMode} />;
    case "history":
      return <HistoryView content={content} display={view.display} nowIso={view.nowIso} developerMode={view.developerMode} />;
  }
}

export function ReviewScreen({ view }: { view: ReviewView }) {
  return (
    <ReviewTransition>
      <PageHeader
        eyebrow={view.scopeLabel}
        title={REVIEW_TITLE}
        // On phones the scope and the run button come first; the page explains itself in each tab's side notes.
        description={<span className="hidden sm:inline">{REVIEW_DESCRIPTION}</span>}
        className="mb-4 [&_.page-header-description]:mt-0 sm:[&_.page-header-description]:mt-1"
      />
      <ReviewContextScope current={view.contextValue} className="flex flex-col gap-6">
        <ReviewTabStrip>
          <TabLinks
            label={REVIEW_TABS_LABEL}
            className={TAB_STRIP}
            items={view.tabs.map(tab => ({ href: tab.href, label: <ReviewTabLabel label={tab.label} shortLabel={tab.shortLabel} />, current: tab.current }))}
          />
        </ReviewTabStrip>
        <Notices notices={view.notices} />
        <Content view={view} />
      </ReviewContextScope>
    </ReviewTransition>
  );
}
