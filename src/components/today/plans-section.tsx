import { ArrowRight, ClipboardList, OctagonX } from "lucide-react";
import Link from "next/link";
import { StatusPill } from "@/components/ui/badge";
import { TradeRowMenu } from "@/components/trade/trade-row-menu";
import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Disclosure } from "@/components/ui/disclosure";
import { CheckRiskButton } from "./check-risk-button";
import {
  checkedOnLead, EARLIER_LOCKED_LABEL, EARLIER_LOCKED_NOTE, OLDER_DRAFTS_LABEL, PLANS_DESCRIPTION, PLANS_EMPTY_DESCRIPTION, PLANS_EMPTY_TITLE, PLANS_TITLE,
} from "./copy";
import { AccountName, InlineEmpty, TodaySection } from "./section";
import { SkipPlanButton } from "./skip-plan-button";
import type { PlanActionView, PlanReasonView, PlanRowView, PlansView } from "./types";

/**
 * Plans waiting (docs/V2_ARCHITECTURE.md §14.1, §2.4): plans locked today and waiting for entry, then drafts by their
 * check (Ready to lock, Recheck needed, Blocked with its first reason, Draft), each with its next step. Plans locked on
 * an earlier day follow under their own label (their slot and risk count on that day) with Record entry and Skip; a
 * block found on an earlier day says so and offers the free re-check. Drafts not touched today come last, folded away
 * when there are many; the Journal lists every draft.
 */

const PLANS_HEADING_ID = "today-plans-title";

function PlanAction({ action, title }: { action: PlanActionView; title: string }) {
  switch (action.kind) {
    case "check":
      return <CheckRiskButton tradeId={action.tradeId} label={action.label} title={title} />;
    case "skip":
      return <SkipPlanButton tradeId={action.tradeId} title={title} lockedOn={action.lockedOn} label={action.label} focusAfterId={PLANS_HEADING_ID} />;
    case "link":
      return (
        <Link href={action.href} prefetch={action.prefetch} className={buttonClasses({ variant: action.variant, size: "sm" })} aria-label={`${action.label}: ${title}`}>
          {action.label}
          {action.variant === "primary" && <ArrowRight aria-hidden="true" />}
        </Link>
      );
  }
}

function Reason({ reason }: { reason: PlanReasonView }) {
  // A block found on an earlier day is history: the sentence keeps its words, and the day it described leads it.
  if (reason.checkedOn !== null) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-2">
        <OctagonX aria-hidden="true" className="mt-0.5 size-3.5 flex-none text-3" />
        <span>
          <span className="sr-only">Blocked. </span>
          <span className="font-medium text-1">{checkedOnLead(reason.checkedOn)}</span> {reason.text}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-sm text-neg">
      <OctagonX aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
      <span>
        <span className="sr-only">Blocked: </span>
        {reason.text}
      </span>
    </p>
  );
}

function PlanRow({ row, showAccount }: { row: PlanRowView; showAccount: boolean }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 md:px-5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={row.href} className="-my-2 py-2 font-semibold text-1 hover:underline">
            {row.title}
          </Link>{" "}
          <StatusPill tone={row.state.tone}>{row.state.label}</StatusPill>
          {showAccount && (
            <>
              {" "}
              <AccountName name={row.accountName} className="t-meta" />
            </>
          )}
        </p>
        <p className="t-meta num">{row.meta}</p>
        {row.reason && <Reason reason={row.reason} />}
      </div>
      <div className="flex flex-none flex-wrap items-start gap-2">
        {row.actions.map(action => (
          <PlanAction key={`${action.kind}-${action.label}`} action={action} title={row.title} />
        ))}
        <TradeRowMenu tradeId={row.id} href={row.href} label={row.title} open={row.menu.open} duplicate={row.menu.duplicate} />
      </div>
    </li>
  );
}

function RowList({ rows, showAccount }: { rows: PlanRowView[]; showAccount: boolean }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map(row => (
        <PlanRow key={row.id} row={row} showAccount={showAccount} />
      ))}
    </ul>
  );
}

function MoreInJournal({ count, href }: { count: number; href: string }) {
  if (count <= 0) return null;
  return (
    <p className="border-t border-border px-4 py-3 t-meta md:px-5">
      {count} more in the{" "}
      <Link href={href} className="font-medium text-accent hover:underline">
        Journal
      </Link>
      .
    </p>
  );
}

/** A labelled group below today's rows; folded into a disclosure when it holds many rows. */
function PlanGroup({
  label, note, rows, hidden = 0, fold, separated, showAccount, journalHref,
}: {
  label: string;
  note?: string;
  rows: PlanRowView[];
  /** Rows not listed here (the Journal lists them). */
  hidden?: number;
  fold: boolean;
  /** Rows above: a hairline separates the group. */
  separated: boolean;
  showAccount: boolean;
  journalHref: string;
}) {
  const list = (
    <>
      <div className="border-t border-border">
        <RowList rows={rows} showAccount={showAccount} />
      </div>
      <MoreInJournal count={hidden} href={journalHref} />
    </>
  );
  if (!fold) {
    return (
      <div className={cx(separated && "border-t border-border")}>
        <div className="bg-surface-sunken px-4 py-1.5 md:px-5">
          <p className="text-xs font-medium text-2">{label}</p>
          {note && <p className="t-caption">{note}</p>}
        </div>
        {list}
      </div>
    );
  }
  return (
    <div className={cx(separated && "border-t border-border")}>
      <Disclosure summary={`${label} (${rows.length + hidden})`} className="rounded-none border-0 bg-transparent [&>summary]:px-4 md:[&>summary]:px-5" bodyClassName="p-0">
        {note && <p className="border-t border-border bg-surface-sunken px-4 py-1.5 t-caption md:px-5">{note}</p>}
        {list}
      </Disclosure>
    </div>
  );
}

export function PlansWaitingSection({ plans, showAccount }: { plans: PlansView; showAccount: boolean }) {
  return (
    <TodaySection
      id={PLANS_HEADING_ID}
      title={PLANS_TITLE}
      count={plans.total}
      description={PLANS_DESCRIPTION}
      aside={plans.total > 0 ? <span>{plans.summary}</span> : null}
    >
      {plans.total === 0 ? (
        <InlineEmpty icon={<ClipboardList />} title={PLANS_EMPTY_TITLE} description={PLANS_EMPTY_DESCRIPTION} />
      ) : (
        <div className="card overflow-hidden">
          {plans.current.length > 0 && <RowList rows={plans.current} showAccount={showAccount} />}
          {plans.earlierLocked.length > 0 && (
            <PlanGroup
              label={EARLIER_LOCKED_LABEL}
              note={EARLIER_LOCKED_NOTE}
              rows={plans.earlierLocked}
              fold={plans.foldEarlierLocked}
              separated={plans.current.length > 0}
              showAccount={showAccount}
              journalHref={plans.journalHref}
            />
          )}
          {plans.older.length > 0 && (
            <PlanGroup
              label={`${OLDER_DRAFTS_LABEL} · not touched today`}
              rows={plans.older}
              hidden={plans.olderHidden}
              fold={plans.foldOlder}
              separated={plans.current.length + plans.earlierLocked.length > 0}
              showAccount={showAccount}
              journalHref={plans.journalHref}
            />
          )}
          {plans.truncated && (
            <p className="border-t border-border px-4 py-3 t-meta md:px-5">
              Today shows the newest plans and drafts.{" "}
              <Link href={plans.journalHref} className="font-medium text-accent hover:underline">
                See every one in the Journal
              </Link>
            </p>
          )}
        </div>
      )}
    </TodaySection>
  );
}
