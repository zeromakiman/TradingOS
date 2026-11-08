import { Disclosure } from "@/components/ui/disclosure";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { plural } from "@/domain/format";
import { MAX_LEDGER_ROWS } from "@/lib/performance-data";

/** Plain-words definitions of every EDGE figure (§14.6); calculation codes stay in Technical details. */
export const DEFINITIONS: readonly { term: string; definition: string }[] = [
  { term: "Closed trades", definition: "Planned, live-first and imported trades with a recorded exit that match the filters. The date range selects trades by the strategy day (UTC−5) of their exit." },
  { term: "Realized R", definition: "Net P&L after fees divided by the trade's initial risk. Planned trades use the risk locked in the plan; live-first and imported trades use the risk recorded for the trade (reported, or derived from entry, stop and size). A trade without a recorded risk has no R and is left out of every R statistic; its P&L still counts." },
  { term: "Net R", definition: "The sum of realized R." },
  { term: "Expectancy", definition: "Average R per trade: win rate × average winner plus loss rate × average loser. It equals net R divided by the number of trades with R." },
  { term: "Win rate", definition: "Winning trades divided by all trades with R, break-even trades included in the denominator." },
  { term: "Profit factor", definition: "Gross positive R divided by the absolute gross negative R. \"No losses\" when no trade lost." },
  { term: "Max R drawdown", definition: "The largest fall of cumulative R below its running peak, starting at 0R, with trades in exit order." },
  { term: "Net P&L and gross realized loss", definition: "Sums of net P&L, and of the losses of losing trades, per currency. Currencies are never converted or added together." },
  { term: "Sessions and weekdays", definition: "Taken from the entry time on the strategy clock (UTC−5). Trades without a known entry time are grouped as \"Entry time unknown\"." },
  { term: "Sample size", definition: "Below 10 trades a sample is early and win rate, profit factor and expectancy are muted. Groups are compared only with their own N: below 10 trades \"Insufficient evidence\", 10–29 \"Emerging tendency\", and no group is called better below 30." },
  { term: "All Accounts", definition: "R is per-trade risk units, not money, so R statistics combine every account; drawdown uses the combined exit order. Money, balances and percentages stay per account and per currency." },
];

export function EdgeDefinitions({ rows, truncated }: { rows: number; truncated: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <Disclosure summary="Calculation definitions" id="definitions">
        <dl className="grid gap-x-8 gap-y-3 md:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]">
          {DEFINITIONS.map(entry => (
            <div key={entry.term} className="contents">
              <dt className="font-medium">{entry.term}</dt>
              <dd className="t-meta mb-2 md:mb-0">{entry.definition}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
      <TechnicalDetails>
        <dl className="grid gap-1 font-mono text-xs">
          <div>
            <dt className="inline">Planned trades: </dt>
            <dd className="inline">FULL_CLOSE_V1 (net ÷ locked nominal risk)</dd>
          </div>
          <div>
            <dt className="inline">Live-first and imported trades: </dt>
            <dd className="inline">UNPLANNED_CLOSE_V1 (net ÷ risk basis; R null without one)</dd>
          </div>
          <div>
            <dt className="inline">Ledger rows in the statistics: </dt>
            <dd className="inline">
              {plural(rows, "row")} (read limit {MAX_LEDGER_ROWS}){truncated ? " · truncated" : ""}
            </dd>
          </div>
          <div>
            <dt className="inline">Source: </dt>
            <dd className="inline">public.trade_ledger, keyset by id; R statistics exit-ordered with microsecond keys and id tie-break</dd>
          </div>
        </dl>
      </TechnicalDetails>
    </div>
  );
}
