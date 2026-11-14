import { ArrowLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import { DeletedTradeActions } from "@/components/trade/delete-dialogs";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { DeletedTradesView } from "@/lib/trades-data";

/**
 * Deleted trades (0020). A trade here is hidden everywhere else but still counts toward the day's limits; Restore
 * brings it back unchanged, Delete permanently removes it (typed confirmation) once it no longer counts toward today.
 * Server component; the two actions are client dialogs.
 */
export function DeletedTradesScreen({ view }: { view: DeletedTradesView }) {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        eyebrow={
          <Link href="/journal" className="inline-flex items-center gap-1 text-accent">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Journal
          </Link>
        }
        title="Deleted trades"
        description={
          <>
            <span className="font-medium text-1">{view.contextLabel}</span> · Hidden from the Journal, EDGE, calendars, dashboards and Today. They still
            count toward the day&apos;s limits.
          </>
        }
      />
      <Callout tone="info">
        Restore puts a trade back exactly as it was. Delete permanently removes the trade with its plan, fills, journal, tags, screenshots and AI
        results; AI spend and accounting records are kept. A trade that counts toward today&apos;s limits can be deleted permanently from 00:00 UTC−5
        tomorrow.
      </Callout>
      {view.trades.length === 0 ? (
        <EmptyState
          className="card"
          headingLevel={2}
          icon={<Trash2 />}
          title="No deleted trades"
          description="Trades you delete from the Journal, Today or a trade page wait here until you restore them or delete them permanently."
          actions={[
            <Link key="journal" href="/journal" className={buttonClasses({ variant: "secondary" })}>
              Back to the Journal
            </Link>,
          ]}
        />
      ) : (
        <ol className="card divide-y divide-border overflow-hidden" aria-label="Deleted trades">
          {view.trades.map(trade => (
            <li key={trade.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link href={`/trades/${trade.id}`} className="truncate font-semibold text-1 hover:underline">
                  {trade.title}
                </Link>
                <span className="t-meta min-w-0 truncate">
                  {[trade.dateLabel, trade.accountName, trade.stateLabel, trade.resultLabel].filter(Boolean).join(" · ")}
                </span>
                <span className="t-caption">
                  Deleted {trade.deletedLabel}
                  {trade.countsToday ? " · counts toward today's limits; delete it permanently from tomorrow" : ""}
                </span>
              </div>
              <DeletedTradeActions tradeId={trade.id} label={trade.title} countsToday={trade.countsToday} />
            </li>
          ))}
        </ol>
      )}
      {view.truncated && <p className="t-caption">Showing the 200 most recently deleted trades.</p>}
    </div>
  );
}
