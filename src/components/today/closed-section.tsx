import { ArrowRight, CircleCheckBig } from "lucide-react";
import Link from "next/link";
import { Badge, StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { CLOSED_EMPTY_DESCRIPTION, CLOSED_EMPTY_TITLE, CLOSED_TITLE, NO_R_COPY } from "./copy";
import { InlineEmpty, TodaySection, Value } from "./section";
import type { ClosedTradeView } from "./types";

/**
 * Today's closed trades (docs/V2_ARCHITECTURE.md §14.1): latest exit first, with realized R (per-trade risk units) and
 * net P&L in the account's own currency, and "Write review" for trades whose review is still pending.
 */

function ClosedRow({ trade, showAccount }: { trade: ClosedTradeView; showAccount: boolean }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:px-5 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={trade.href} className="-my-2 py-2 font-semibold text-1 hover:underline">
            {trade.title}
          </Link>{" "}
          <Badge title={trade.origin.tooltip ?? undefined}>
            {trade.origin.label}
            {trade.origin.tooltip && <span className="sr-only">: {trade.origin.tooltip}</span>}
          </Badge>
        </p>
        <p className="t-meta truncate num">
          {showAccount && <span>{trade.accountName} · </span>}
          {trade.exit}
        </p>
      </div>
      <p className="flex flex-col items-end text-right">
        {trade.r ? (
          <Value value={trade.r} className="text-base leading-6 font-semibold" />
        ) : (
          <span className="text-sm leading-6 text-3" title={NO_R_COPY}>
            <span aria-hidden="true">No R</span>
            <span className="sr-only">{NO_R_COPY}</span>
          </span>
        )}
        {trade.pnl && (
          <>
            {" "}
            <Value value={trade.pnl} className="text-sm" />
          </>
        )}
      </p>
      <div className="col-span-2 flex flex-wrap items-center gap-2 lg:col-span-1 lg:justify-end">
        <StatusPill tone={trade.state.tone}>{trade.state.label}</StatusPill>
        {trade.action && " "}
        {trade.action && (
          <Link href={trade.action.href} className={buttonClasses({ variant: "secondary", size: "sm" })} aria-label={`${trade.action.label}: ${trade.title}`}>
            {trade.action.label}
            <ArrowRight aria-hidden="true" />
          </Link>
        )}
      </div>
    </li>
  );
}

export function ClosedTodaySection({
  trades, showAccount, journalHref, truncated,
}: { trades: ClosedTradeView[]; showAccount: boolean; journalHref: string; truncated: boolean }) {
  return (
    <TodaySection
      id="today-closed-title"
      title={CLOSED_TITLE}
      count={trades.length}
      aside={
        trades.length > 0 ? (
          <Link href={journalHref} className="font-medium text-accent hover:underline">
            {truncated ? "Every trade closed today in the Journal" : "Open in the Journal"}
          </Link>
        ) : null
      }
    >
      {trades.length === 0 ? (
        <InlineEmpty icon={<CircleCheckBig />} title={CLOSED_EMPTY_TITLE} description={CLOSED_EMPTY_DESCRIPTION} />
      ) : (
        <ul className="card flex flex-col divide-y divide-border overflow-hidden">
          {trades.map(trade => (
            <ClosedRow key={trade.id} trade={trade} showAccount={showAccount} />
          ))}
        </ul>
      )}
    </TodaySection>
  );
}
