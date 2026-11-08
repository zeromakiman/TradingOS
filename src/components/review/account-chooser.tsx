import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { PERIODIC_LIMITATION } from "@/components/ai/model";
import { StatusPill } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { CHOOSE_TITLE } from "./copy";
import { ReviewPendingRegion } from "./pending";
import type { ChooseContent, ChooserRow } from "./review-data";
import { TransitionLink } from "./transition-link";

/**
 * All Accounts without a chosen account (docs/V2_ARCHITECTURE.md §9.1, §11.5): a periodic review always covers one
 * trading account, so the trader picks it explicitly. Each row says what the period holds for that account and
 * whether its AI budget can run a review; nothing is requested from here.
 */

/**
 * Phones: name and AI status on the first line, the period's summary under the name. Wider screens: account, period,
 * AI budget and the chevron in four columns.
 */
function Row({ row, periodLabel }: { row: ChooserRow; periodLabel: string }) {
  return (
    <li>
      <TransitionLink
        href={row.href}
        className="group -mx-2 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 rounded-control px-2 py-3 hover:bg-surface-sunken sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto] sm:gap-x-4"
      >
        <span className="col-start-1 row-start-1 flex min-w-0 flex-col">
          <span className="truncate font-semibold text-text group-hover:text-accent">{row.account.name}</span>
          <span className="t-meta">{row.account.detail}</span>
        </span>
        <span className="col-span-3 col-start-1 row-start-2 flex min-w-0 flex-wrap gap-x-1 text-[0.8125rem] leading-5 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:flex-col">
          <span className="text-2">
            {periodLabel}
            <span aria-hidden="true" className="sm:hidden">
              {" "}
              ·
            </span>
          </span>
          <span className="font-medium text-text">{row.summary ?? "Trade counts unavailable"}</span>
        </span>
        <span className="col-start-2 row-start-1 flex min-w-0 flex-col items-end gap-1 sm:col-start-3 sm:items-start">
          <span className="flex items-center gap-1.5 text-[0.8125rem] text-2">
            AI
            <StatusPill tone={row.status.tone}>{row.status.label}</StatusPill>
          </span>
          <span className="t-caption num hidden sm:block">{row.usage}</span>
        </span>
        <ChevronRight aria-hidden="true" className="col-start-3 row-start-1 size-4 text-3 sm:col-start-4" />
      </TransitionLink>
    </li>
  );
}

export function AccountChooser({ content }: { content: ChooseContent }) {
  const headingId = useId();
  return (
    <ReviewPendingRegion>
      <Card as="section" aria-labelledby={headingId}>
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle as="h2" id={headingId}>
              {CHOOSE_TITLE}
            </CardTitle>
            <CardDescription>{content.description}</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <ul aria-label="Trading accounts" className="flex flex-col divide-y divide-border">
            {content.active.map(row => (
              <Row key={row.account.id} row={row} periodLabel={content.periodLabel} />
            ))}
          </ul>
          {content.archived.length > 0 && (
            <Disclosure summary={`Archived accounts (${content.archived.length})`} className="border-0 bg-transparent [&>div]:px-0 [&>summary]:px-0">
              <ul aria-label="Archived trading accounts" className="flex flex-col divide-y divide-border">
                {content.archived.map(row => (
                  <Row key={row.account.id} row={row} periodLabel={content.periodLabel} />
                ))}
              </ul>
            </Disclosure>
          )}
          <p className="t-caption border-t border-border pt-3">{PERIODIC_LIMITATION}</p>
        </CardBody>
      </Card>
    </ReviewPendingRegion>
  );
}
