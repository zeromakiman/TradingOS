import { Calculator } from "lucide-react";
import { cx } from "@/components/ui/cx";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { closeFormContext } from "./close-model";
import { CloseTradeForm } from "./close-trade-form";
import { closeMode, listInWords, outcomeView, riskBasisPreview, whenLabel } from "./model";
import { TRADE_TARGETS } from "./reveal";
import { WorkspaceSection } from "./section";

/**
 * Result section (docs/V2_ARCHITECTURE.md §3.4–3.5, §14.4). While the position is live: the close form (planned
 * trades: exit, time and fees; live-first trades: the exit price, or the net P&L when price math is impossible), given
 * the position's facts (`closeFormContext`) so its confirmation shows the net P&L and R before the close is recorded and
 * the partial closes journaled while live give the average exit (§3.6). Once closed: realized R, net P&L and the
 * outcome, with the calculation basis in words ("R based on locked risk" / "R based on risk recorded after entry") and
 * the exit facts. Server component.
 */

export interface ResultSectionProps {
  detail: TradeDetail;
  now: string;
  display: TimeDisplay;
}

const TONE = { positive: "value-pos", negative: "value-neg", neutral: "text-text" } as const;

/** `Win · closed Oct 23, 05:50`, or `Closed Oct 23, 05:50` without an outcome. */
function closedLine(outcome: string | null, when: string): string {
  return outcome ? `${outcome} · closed ${when}` : `Closed ${when}`;
}

function CloseSection({ detail, now, display }: ResultSectionProps) {
  const mode = closeMode(detail);
  const enteredAt = detail.execution?.enteredAt ?? null;
  return (
    <WorkspaceSection id="result" title="Close trade" meta="Record one exit for the whole position when you are out.">
      <div id={TRADE_TARGETS.closeTrade} className="scroll-mt-24">
        <CloseTradeForm
          tradeId={detail.tradeId}
          mode={mode.kind}
          missing={mode.kind === "reported" ? listInWords(mode.missing) : undefined}
          currency={detail.account.currency}
          tickSize={detail.instrument?.tickSize ?? null}
          basis={riskBasisPreview(detail)}
          entered={enteredAt ? { at: enteredAt, label: whenLabel(enteredAt, now, display) } : null}
          display={display}
          nowIso={now}
          context={closeFormContext(detail)}
        />
      </div>
    </WorkspaceSection>
  );
}

function OutcomeSection({ detail, now, display }: ResultSectionProps) {
  const outcome = outcomeView(detail, now, display);
  if (!outcome) return null;
  const { summary } = outcome;
  return (
    <WorkspaceSection id="result" title="Result" meta={closedLine(summary.outcome, whenLabel(outcome.exitedAt, now, display))}>
      {/* The outcome in words leads the section's meta line; the two numbers carry the result. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 @md:grid-cols-3" aria-label="Realized result">
        <div className="min-w-0">
          <dt className="t-meta">Realized R</dt>
          <dd className={cx("num text-2xl font-semibold leading-8", summary.r ? TONE[summary.tone] : "text-text-3")}>{summary.r ?? "Not available"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="t-meta">Net P&L</dt>
          <dd className={cx("num text-2xl font-semibold leading-8", TONE[summary.tone])}>{summary.money ?? "—"}</dd>
        </div>
      </dl>
      <p className="t-meta flex items-start gap-2" data-basis="">
        <Calculator aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-3" />
        <span>{outcome.basis}</span>
      </p>
      <dl aria-label="Exit" className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 @md:grid-cols-3">
        {outcome.facts.map(fact => (
          <div key={fact.label} className="min-w-0">
            <dt className="t-caption">{fact.label}</dt>
            <dd className={cx("break-words", fact.value === null ? "text-text-3" : "num font-medium text-text")}>{fact.value ?? "Not recorded"}</dd>
            {fact.hint && <dd className="t-caption num">{fact.hint}</dd>}
          </div>
        ))}
      </dl>
    </WorkspaceSection>
  );
}

export function ResultSection(props: ResultSectionProps) {
  const { lifecycle } = props.detail.state;
  if (lifecycle === "LIVE") return <CloseSection {...props} />;
  if (lifecycle === "CLOSED" || lifecycle === "REVIEWED") return <OutcomeSection {...props} />;
  return null;
}
