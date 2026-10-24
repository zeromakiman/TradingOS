import { ArrowRight, CircleCheck, OctagonX, Settings2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { STATUS_TITLE } from "./copy";
import { accountRowHeadingId, STATUS_HEADING_ID } from "./dom-ids";
import { Value } from "./section";
import { AccountRowMenu, AccountStatusDialogs, ConfirmValuesButton, RefreshButton, type StatusAccount, StatusDialogButton } from "./status-actions";
import type { AccountStatusView, DaySummaryView, HeadlineTone, ReasonView, StatView } from "./types";

/**
 * Trading status of Today (docs/V2_ARCHITECTURE.md §14.1, §6.2, §8.4, §9.3): can I trade, why not, and the day's
 * numbers. One card for the selected account; in All Accounts a summary of the day across accounts (R across accounts,
 * money per currency) and one compact row per active account. Every reason comes from `dailyStatusV2`, BLOCK first,
 * each with its action in place; Confirm unchanged always shows the values it records.
 */

/** What the account's dialogs and Confirm unchanged need (ids stay handles; nothing here is printed raw). */
function statusAccount(status: AccountStatusView): StatusAccount {
  const values = status.values;
  return {
    accountId: status.accountId,
    name: status.name,
    currency: status.currency,
    canAddExternalLoss: status.canAddExternalLoss,
    external: status.externalAmount,
    externalSummary: status.externalSummary,
    values: { balance: values.balance, equity: values.equity, valuesText: values.values, recorded: values.recorded, observationId: values.observationId },
  };
}

function ConfirmButton({ status, focusAfterId }: { status: AccountStatusView; focusAfterId: string }) {
  const values = status.values;
  if (!values.observationId) return null;
  return (
    <ConfirmValuesButton
      accountId={status.accountId}
      accountName={status.name}
      observationId={values.observationId}
      valuesText={values.values}
      recorded={values.recorded}
      focusAfterId={focusAfterId}
    />
  );
}

/** The headline's icon in its tone; the words of the headline carry the meaning. */
const HEADLINE: Readonly<Record<HeadlineTone, { icon: ReactNode; badge: string }>> = {
  positive: { icon: <CircleCheck aria-hidden="true" />, badge: "bg-pos-soft text-pos" },
  warning: { icon: <TriangleAlert aria-hidden="true" />, badge: "bg-warn-soft text-warn" },
  negative: { icon: <OctagonX aria-hidden="true" />, badge: "bg-neg-soft text-neg" },
};

function Headline({ status, size = "lg" }: { status: AccountStatusView; size?: "lg" | "md" }) {
  const tone = HEADLINE[status.tone];
  return (
    <p className={cx("flex min-w-0 items-center gap-2.5 font-semibold text-1", size === "lg" ? "text-lg leading-7" : "text-sm leading-5")}>
      <span className={cx("grid flex-none place-items-center rounded-pill", tone.badge, size === "lg" ? "size-8 [&_svg]:size-[1.125rem]" : "size-6 [&_svg]:size-3.5")}>
        {tone.icon}
      </span>
      <span className="min-w-0">{status.headline}</span>
    </p>
  );
}

/** The action that resolves one reason, in place. */
function ReasonActionView({ reason, status, focusAfterId }: { reason: ReasonView; status: AccountStatusView; focusAfterId: string }) {
  const action = reason.action;
  if (!action) return null;
  switch (action.kind) {
    case "confirm-values":
      return (
        <span className="flex flex-wrap items-start gap-2">
          <ConfirmButton status={status} focusAfterId={focusAfterId} />
          <StatusDialogButton kind="values" variant="secondary" />
        </span>
      );
    case "record-values":
      return <StatusDialogButton kind="values" variant="primary" />;
    case "refresh":
      return <RefreshButton label={action.label} />;
    case "link":
      return (
        <Link href={action.href} prefetch={action.prefetch} className={buttonClasses({ variant: "secondary", size: "sm" })}>
          {action.label}
          <ArrowRight aria-hidden="true" />
        </Link>
      );
  }
}

const SEVERITY = {
  BLOCK: { label: "Blocking", icon: <OctagonX aria-hidden="true" />, className: "text-neg" },
  WARN: { label: "Warning", icon: <TriangleAlert aria-hidden="true" />, className: "text-warn" },
} as const;

function ReasonList({ status }: { status: AccountStatusView }) {
  if (!status.reasons.length) return null;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-control border border-border" aria-label={`Reasons for ${status.name}`}>
      {status.reasons.map(reason => {
        const severity = SEVERITY[reason.severity];
        return (
          <li key={reason.message} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="flex min-w-0 items-start gap-2 text-sm text-1">
              <span className={cx("mt-0.5 flex flex-none items-center gap-1 text-xs font-semibold [&_svg]:size-3.5", severity.className)}>
                {severity.icon}
                {severity.label}
              </span>{" "}
              <span className="min-w-0">{reason.message}</span>
            </p>
            <span className="flex flex-none flex-wrap items-center gap-2 sm:justify-end">
              <ReasonActionView reason={reason} status={status} focusAfterId={STATUS_HEADING_ID} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StatCell({ stat, children, className }: { stat: StatView; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1 bg-surface px-4 py-3 md:px-5", className)}>
      <p className="text-xs font-medium text-2">{stat.label}</p>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xl leading-7 font-semibold">
        {stat.values.map((value, index) => (
          <Fragment key={value.text}>
            {index > 0 && " "}
            <Value value={value} />
          </Fragment>
        ))}
      </p>
      {stat.hint && <p className="t-caption">{stat.hint}</p>}
      {children}
    </div>
  );
}

function StatsGrid({ status }: { status: AccountStatusView }) {
  const stats = status.stats;
  if (!stats) return null;
  const { losses, values } = stats;
  return (
    // Hairlines between cells: the grid's 1px gaps show its border-coloured background.
    <div className="grid grid-cols-2 gap-px border-t border-border bg-border md:grid-cols-3 xl:grid-cols-5">
      <StatCell stat={stats.trades} />
      <StatCell stat={stats.risk} />
      <StatCell stat={stats.result} />
      <StatCell stat={{ label: "Realized losses today", values: [{ text: losses.realized, tone: "neutral" }], hint: null }}>
        {losses.external && <p className="text-sm font-medium text-1 num">{losses.external}</p>}
        <p className="t-caption">{losses.detail}</p>
        <p className="t-caption">{losses.limit}</p>
        {losses.counted && <p className="t-caption text-warn">{losses.counted}</p>}
        {status.canAddExternalLoss && (
          <span className="-ml-2 pt-1">
            <StatusDialogButton kind="loss" />
          </span>
        )}
      </StatCell>
      <div className="col-span-2 flex min-w-0 flex-col gap-1 bg-surface px-4 py-3 md:px-5 xl:col-span-1">
        <p className="text-xs font-medium text-2">Account values</p>
        <p className={cx("flex items-center gap-1.5 text-sm leading-7 font-semibold", values.confirmedToday ? "text-pos" : "text-warn")}>
          {values.confirmedToday ? <CircleCheck aria-hidden="true" className="size-4 flex-none" /> : <TriangleAlert aria-hidden="true" className="size-4 flex-none" />}
          {values.label}
        </p>
        {values.lines.map(line => (
          <p key={line} className="t-caption num">
            {line}
          </p>
        ))}
        {values.recorded && <p className="t-caption">{values.recorded}</p>}
        {/* Before today's confirmation the blocking reason above carries these actions. */}
        {values.observationId && values.confirmedToday && (
          <span className="-ml-2 pt-1">
            <StatusDialogButton kind="values" />
          </span>
        )}
      </div>
    </div>
  );
}

/** One account in context: the full card. */
export function AccountStatusCard({ status }: { status: AccountStatusView }) {
  return (
    <section aria-labelledby={STATUS_HEADING_ID} className="card overflow-hidden">
      <AccountStatusDialogs account={statusAccount(status)} focusFallbackId={STATUS_HEADING_ID}>
        <div className="flex flex-col gap-3 p-4 md:p-5">
          <div className="flex items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id={STATUS_HEADING_ID} className="text-xs font-medium text-2">
                {STATUS_TITLE} · {status.name}
              </h2>
              <Headline status={status} />
            </div>
            <Link href={status.manageHref} className={buttonClasses({ variant: "ghost", size: "sm", className: "flex-none max-sm:px-2" })}>
              <Settings2 aria-hidden="true" />
              {/* Phones keep the icon beside the headline; the words stay for assistive technology. */}
              <span className="max-sm:sr-only">Manage account</span>
            </Link>
          </div>
          <ReasonList status={status} />
        </div>
        <StatsGrid status={status} />
      </AccountStatusDialogs>
    </section>
  );
}

function CompactStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[0.6875rem] leading-4 font-medium text-3">{label}</dt>
      <dd className="truncate text-sm leading-5 font-semibold">{children}</dd>
    </div>
  );
}

/**
 * Confirm unchanged in a compact row, with the values it records beside it: a balance and equity size every position,
 * so they are never confirmed unseen. Wide rows put the values under the button; phones read them first.
 */
function ConfirmWithValues({ status, layout, focusAfterId }: { status: AccountStatusView; layout: "side" | "stacked"; focusAfterId: string }) {
  const values = status.values;
  const caption = (
    <p className={cx("t-caption", layout === "side" && "text-right")}>
      <span className="font-medium text-1 num">{values.values}</span>
      {values.recorded && (
        <>
          <br />
          {values.recorded}
        </>
      )}
    </p>
  );
  const button = <ConfirmButton status={status} focusAfterId={focusAfterId} />;
  return layout === "side" ? (
    <div className="flex flex-col items-end gap-1.5">
      {button}
      {caption}
    </div>
  ) : (
    <div className="flex flex-col items-start gap-2">
      {caption}
      {button}
    </div>
  );
}

/**
 * The one action of a compact row: the first reason's own action, reduced to a single button (the menu holds account
 * values, external losses and the rest).
 */
function PrimaryRowAction({ status, layout, focusAfterId }: { status: AccountStatusView; layout: "side" | "stacked"; focusAfterId: string }) {
  const reason = status.reasons.find(item => item.action !== null);
  const action = reason?.action;
  if (!reason || !action) return null;
  if (action.kind === "confirm-values" && status.values.observationId) return <ConfirmWithValues status={status} layout={layout} focusAfterId={focusAfterId} />;
  return <ReasonActionView reason={reason} status={status} focusAfterId={focusAfterId} />;
}

/**
 * One account in All Accounts. Narrow screens stack name, status, numbers and the action; wide screens keep the name
 * on the left, status over numbers in the middle and the action on the right, so every row lines up.
 */
function AccountRow({ status }: { status: AccountStatusView }) {
  const stats = status.stats;
  const first = status.reasons[0];
  const more = status.reasons.length - 1;
  // The account's name link takes focus when an action resolved its reason and the button left with it.
  const headingId = accountRowHeadingId(status.accountId);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 px-4 py-3.5 md:px-5 xl:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] xl:gap-x-6">
      <AccountStatusDialogs account={statusAccount(status)} focusFallbackId={headingId}>
        <div className="min-w-0 xl:row-span-2">
          <h3 className="text-sm leading-6 font-semibold text-1">
            {/* The negative margin keeps the row's rhythm while the padding gives the link a 40px hit area. */}
            <Link id={headingId} href={status.focusHref} prefetch={false} className="-my-2 block truncate py-2 hover:underline" title={`Show only ${status.name}`}>
              {status.name}
            </Link>
          </h3>
          <p className="t-caption truncate">{status.meta}</p>
        </div>
        <div className="col-start-2 row-start-1 flex items-start justify-end gap-1 xl:col-start-3 xl:row-span-2">
          <span className="max-sm:hidden">
            <PrimaryRowAction status={status} layout="side" focusAfterId={headingId} />
          </span>
          <AccountRowMenu focusHref={status.focusHref} manageHref={status.manageHref} />
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5 xl:col-span-1 xl:col-start-2 xl:row-start-1">
          <Headline status={status} size="md" />
          {first && (
            <p className="t-caption line-clamp-2 pl-8.5">
              {first.message}
              {more > 0 ? ` (+${more} more)` : ""}
            </p>
          )}
        </div>
        {stats && (
          <dl className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4 xl:col-span-1 xl:col-start-2 xl:row-start-2 xl:pl-8.5">
            <CompactStat label="Trades left">
              <Value value={stats.trades.values[0]} />
            </CompactStat>
            <CompactStat label="Risk left">
              <Value value={stats.risk.values[0]} />
            </CompactStat>
            <CompactStat label="Today's result">
              {stats.result.values.map((value, index) => (
                <Fragment key={value.text}>
                  {index > 0 && " "}
                  <Value value={value} className="mr-1.5" />
                </Fragment>
              ))}
            </CompactStat>
            <CompactStat label="Realized losses">
              <span className="num text-1">{stats.losses.combined}</span>
              {stats.losses.external && <span className="ml-1 text-xs font-normal text-2">incl. external</span>}
            </CompactStat>
          </dl>
        )}
        <div className="col-span-2 sm:hidden">
          <PrimaryRowAction status={status} layout="stacked" focusAfterId={headingId} />
        </div>
      </AccountStatusDialogs>
    </li>
  );
}

/** All Accounts: the day across accounts, then one compact row per active account. */
export function AllAccountsStatus({ statuses, summary, detail }: { statuses: AccountStatusView[]; summary: DaySummaryView; detail: string }) {
  const blocked = statuses.filter(status => !status.allowed).length;
  return (
    <section aria-labelledby={STATUS_HEADING_ID} className="card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-end md:justify-between md:p-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={STATUS_HEADING_ID} className="text-xs font-medium text-2">
            {STATUS_TITLE} · All Accounts
          </h2>
          <p className="text-lg leading-7 font-semibold text-1">
            {blocked === 0 ? "You can trade on every account" : blocked === statuses.length ? "Trading is blocked on every account" : `${blocked} of ${statuses.length} accounts blocked`}
          </p>
          <p className="t-caption">{detail} · R is per-trade risk units, not money.</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:flex md:gap-x-8">
          <div className="flex min-w-0 flex-col">
            <dt className="text-xs font-medium text-2">Today's result</dt>
            <dd className="flex flex-wrap items-baseline gap-x-2 text-xl leading-7 font-semibold">
              {summary.r ? <Value value={summary.r} /> : null}
              {summary.money.map(value => (
                <Fragment key={value.text}>
                  {" "}
                  <Value value={value} />
                </Fragment>
              ))}
              {!summary.r && summary.money.length === 0 && <span className="text-3">—</span>}
            </dd>
            <dd className="t-caption">{summary.detail}</dd>
          </div>
          <div className="flex min-w-0 flex-col">
            <dt className="text-xs font-medium text-2">Realized losses today</dt>
            <dd className="text-xl leading-7 font-semibold text-1 num">{summary.losses}</dd>
            <dd className="t-caption">Including external losses</dd>
          </div>
        </dl>
      </div>
      <ul className="flex flex-col divide-y divide-border" aria-label="Trading accounts">
        {statuses.map(status => (
          <AccountRow key={status.accountId} status={status} />
        ))}
      </ul>
    </section>
  );
}
