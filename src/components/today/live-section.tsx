import { ArrowRight, NotebookText, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { Badge, StatusPill } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { LIVE_DESCRIPTION, LIVE_EMPTY_JOURNAL, LIVE_TITLE, RISK_NOT_RECORDED_HINT } from "./copy";
import { liveCardId } from "./dom-ids";
import { LiveDuration } from "./live-duration";
import { LivePanelsProvider, LiveQuickDock, LiveTradeActions } from "./live-panels";
import { TodaySection } from "./section";
import type { LiveFactView, LiveTradeView } from "./types";

/**
 * Live trades on Today (docs/V2_ARCHITECTURE.md §14.1): the open positions first, each with instrument, direction,
 * account, entry, how long it has been live, how it was managed (current stop, partial closes), the initial risk (1R)
 * and the last journal item, plus Add note, Paste screenshot, Close trade and Open in place. Phones get a quick-action
 * dock for the trade in view.
 */

function Fact({ fact }: { fact: LiveFactView }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-2">{fact.label}</dt>
      <dd className={cx("truncate text-sm leading-6 font-semibold num", fact.tone === "muted" ? "font-medium text-3" : fact.tone === "warning" ? "text-warn" : "text-1")}>
        {fact.value}
      </dd>
      {fact.hints.map(hint => (
        <dd key={hint} className="t-caption num">
          {/* Lines break between the parts of a hint, never inside one ("moved Oct 23" stays whole). */}
          {hint.split(" · ").map((part, index) => (
            <Fragment key={part}>
              {index > 0 && " · "}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </dd>
      ))}
    </div>
  );
}

function LastJournal({ trade }: { trade: LiveTradeView }) {
  const last = trade.lastJournal;
  if (!last) {
    return (
      <p className="flex items-center gap-2 rounded-control border border-dashed border-border px-3 py-2 t-meta">
        <NotebookText aria-hidden="true" className="size-4 flex-none text-3" />
        {LIVE_EMPTY_JOURNAL}
      </p>
    );
  }
  return (
    <div className="rounded-control border border-border bg-surface-sunken px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-1">{last.title}</span>{" "}
        <span className="t-caption num">
          {last.time} · {last.relative}
        </span>
      </p>
      {last.body && <p className="mt-0.5 line-clamp-2 text-sm whitespace-pre-line text-2">{last.body}</p>}
    </div>
  );
}

function LiveTradeCard({ trade, nowIso, showAccount }: { trade: LiveTradeView; nowIso: string; showAccount: boolean }) {
  const titleId = `${liveCardId(trade.id)}-title`;
  return (
    <article id={liveCardId(trade.id)} aria-labelledby={titleId} className="@container card flex scroll-mt-20 flex-col gap-3 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={titleId} className="text-base leading-6 font-semibold">
              <Link href={trade.href} className="py-2 text-1 hover:underline">
                {trade.symbol}
                {trade.direction && <span className="font-normal text-2"> · {trade.direction}</span>}
              </Link>
            </h3>{" "}
            <StatusPill tone="live">Live</StatusPill>{" "}
            <Badge title={trade.origin.tooltip ?? undefined}>
              {trade.origin.label}
              {trade.origin.tooltip && <span className="sr-only">: {trade.origin.tooltip}</span>}
            </Badge>
            {trade.oversize && " "}
            {trade.oversize && (
              <StatusPill tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-3" />}>
                Size above plan
              </StatusPill>
            )}
          </div>
          <p className="t-meta">
            {showAccount && <span className="font-medium text-1">{trade.accountName} · </span>}
            <span className="num">{trade.sinceLabel}</span>
            {trade.screenshots && <span className="whitespace-nowrap"> · {trade.screenshots}</span>}
          </p>
        </div>
        <p className="flex flex-none flex-col items-end">
          <span className="text-lg leading-6 font-semibold text-1 num">
            <LiveDuration since={trade.since} nowIso={nowIso} />
          </span>{" "}
          <span className="t-caption">live</span>
        </p>
      </header>
      {/* A wide card (a single live trade) puts the last journal item beside the facts. */}
      <div className="grid gap-3 @3xl:grid-cols-2 @3xl:gap-x-6">
        <div className="flex min-w-0 flex-col gap-1">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            {trade.facts.map(fact => (
              <Fact key={fact.label} fact={fact} />
            ))}
          </dl>
          {trade.addDetailsHref && (
            <p className="flex flex-wrap items-center gap-x-3">
              <Link href={trade.addDetailsHref} className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-accent hover:underline pointer-coarse:min-h-11">
                Add entry details
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
              {!trade.riskRecorded && <span className="t-caption">{RISK_NOT_RECORDED_HINT}</span>}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <LastJournal trade={trade} />
        </div>
      </div>
      <LiveTradeActions
        trade={{
          id: trade.id, title: trade.title, href: trade.href, closeHref: trade.closeHref, requestKey: trade.requestKey, instrument: trade.instrument,
          screenshotCapacity: trade.screenshotCapacity,
        }}
      />
    </article>
  );
}

export function LiveTradesSection({
  trades, nowIso, showAccount, truncated, journalHref,
}: { trades: LiveTradeView[]; nowIso: string; showAccount: boolean; truncated: boolean; journalHref: string }) {
  return (
    <LivePanelsProvider>
      <TodaySection
        id="today-live-title"
        title={LIVE_TITLE}
        count={trades.length}
        description={LIVE_DESCRIPTION}
        aside={
          truncated ? (
            <Link href={journalHref} className="font-medium text-accent hover:underline">
              Every live trade in the Journal
            </Link>
          ) : null
        }
      >
        <ul className={cx("grid gap-4", trades.length > 1 && "xl:grid-cols-2")}>
          {trades.map(trade => (
            <li key={trade.id} className="min-w-0">
              <LiveTradeCard trade={trade} nowIso={nowIso} showAccount={showAccount} />
            </li>
          ))}
        </ul>
      </TodaySection>
      <LiveQuickDock trades={trades.map(trade => ({ id: trade.id, title: trade.title, since: trade.since, closeHref: trade.closeHref }))} nowIso={nowIso} />
    </LivePanelsProvider>
  );
}
