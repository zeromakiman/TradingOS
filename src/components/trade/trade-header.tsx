import { ChevronLeft, CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { accountDashboardHref, manageHref } from "@/components/accounts/copy";
import { withKeys } from "@/components/ai/model";
import { Badge, StatusPill } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { prefetchFor } from "@/components/ui/links";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { LiveFor } from "./live-for";
import { blockingNow, headerActions, headerFacts, type LockSummary, nextStepHint, originBadge, pageState, resultSummary, skipSlotNote } from "./model";
import { TRADE_TITLE_ID } from "./reveal";
import { type TradeActionContext, TradeHeaderActions } from "./trade-actions";

/**
 * Trade header (docs/V2_ARCHITECTURE.md §2.3, §2.4, §14.4): `EURUSD · Long`, the state pill (word + tone), the origin
 * badge, the realized result once closed, the trading account chip, the facts that matter in this state, the one
 * primary next action with the overflow menu, and a sentence that says why that action is next (the first blocking
 * reason of a blocked draft).
 */

const HINT_STYLE = {
  neutral: { icon: Info, className: "text-text-2" },
  positive: { icon: CircleCheck, className: "text-pos" },
  warning: { icon: TriangleAlert, className: "text-warn" },
  danger: { icon: OctagonAlert, className: "text-neg" },
} as const;

/** A no-break space keeps each · with the fact before it, so a wrapped line never starts with a separator. */
const FACT_SEPARATOR = `${String.fromCharCode(0xa0)}· `;

const RESULT_TONE = { positive: "value-pos", negative: "value-neg", neutral: "text-text" } as const;

export interface TradeHeaderProps {
  detail: TradeDetail;
  now: string;
  display: TimeDisplay;
  lock: LockSummary | null;
  keys: TradeActionContext["keys"];
  /** What duplicating copies, in words (`duplicateNotes`). */
  duplicateNotes: readonly string[];
}

export function TradeHeader({ detail, now, display, lock, keys, duplicateNotes }: TradeHeaderProps) {
  const { state, account } = detail;
  const origin = originBadge(detail.origin, state);
  const facts = headerFacts(detail, now, display);
  // What the page knows now about a blocked draft's reasons beyond its check (today's account values).
  const current = blockingNow(lock, now);
  const hint = nextStepHint(detail, now, display, current);
  const result = resultSummary(detail);
  const accountHref = accountDashboardHref(account);
  const context: TradeActionContext = {
    tradeId: detail.tradeId, editHref: `${detail.href}/edit`, expectedRevision: detail.draft?.expectedRevision ?? null, lock, keys, duplicateNotes,
    skipNote: skipSlotNote(detail, now), confirmValuesHref: manageHref(account.id, "account-values"),
  };
  const HintIcon = hint ? HINT_STYLE[hint.tone].icon : null;
  return (
    <header className="flex flex-col gap-3">
      <Link href="/journal" className="inline-flex min-h-10 w-fit items-center gap-1 text-[0.8125rem] font-medium text-text-2 hover:text-text pointer-coarse:min-h-11">
        <ChevronLeft aria-hidden="true" className="size-4" />
        Journal
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 id={TRADE_TITLE_ID} tabIndex={-1} className="page-header-title outline-none">
              {detail.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={state.tone} data-lifecycle={state.lifecycle.toLowerCase()}>
                {state.label}
              </StatusPill>{" "}
              <Badge title={origin.tooltip ?? undefined}>
                {origin.label}
                {origin.tooltip && <span className="sr-only">: {origin.tooltip}</span>}
              </Badge>
            </div>
          </div>
          {result && (
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-result={result.tone}>
              {result.r && <span className={cx("num text-xl font-semibold leading-7", RESULT_TONE[result.tone])}>{result.r}</span>}{" "}
              {result.money && <span className={cx("num font-semibold", result.r ? "" : "text-xl leading-7", RESULT_TONE[result.tone])}>{result.money}</span>}{" "}
              {result.outcome && <span className="t-meta">{result.outcome}</span>}{" "}
              {!result.r && <span className="t-meta">· realized R not available</span>}
            </p>
          )}
          <div className="t-meta flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* Account names run up to 100 characters: the chip shrinks with the header (min-w-0, max-w-full), a long
                name ends in an ellipsis with the whole name in the tooltip and the link's name, and the currency stays. */}
            <Link
              href={accountHref}
              prefetch={prefetchFor(accountHref, undefined)}
              className="group inline-flex min-h-10 max-w-full min-w-0 items-center pointer-coarse:min-h-11"
              aria-label={`Trading account ${account.name} (${account.currency})`}
            >
              <span className="badge max-w-full min-w-0 gap-1.5 group-hover:border-accent group-hover:text-text">
                <span className="truncate" title={account.name}>
                  {account.name}
                </span>{" "}
                <span className="flex-none text-text-3">{account.currency}</span>
              </span>
            </Link>
            {/* A draft's state pill already says it ("Account archived"). */}
            {account.status === "ARCHIVED" && state.lifecycle !== "DRAFT" && <StatusPill tone="muted">Archived account</StatusPill>}
            <span className="num min-w-0">
              {withKeys(facts, fact => fact.text).map(({ key, value: fact }, index) => (
                <span key={key}>
                  {index > 0 && FACT_SEPARATOR}
                  {fact.text}
                  {fact.liveSince && (
                    <>
                      {" · live "}
                      <LiveFor since={fact.liveSince} nowIso={now} />
                    </>
                  )}
                </span>
              ))}
            </span>
          </div>
        </div>
        {/* A draft blocked today only by what no edit clears leads with the step that does (`pageState`). */}
        <TradeHeaderActions model={headerActions(pageState(detail, current), { trashed: detail.technical.ledger.trashed_at !== null })} context={context} />
      </div>
      {hint && HintIcon && (
        <p className={cx("flex max-w-3xl items-start gap-2 text-sm leading-5", HINT_STYLE[hint.tone].className)} data-tone={hint.tone}>
          <HintIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
          <span>{hint.text}</span>
        </p>
      )}
    </header>
  );
}
