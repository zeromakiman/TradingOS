import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatPercent } from "@/domain/format";
import { formatDateTime, formatDuration, type TimeDisplay } from "@/domain/time-display";
import { Badge, StatusPill } from "@/components/ui/badge";
import type { TradeListRow } from "@/lib/trades-data";
import { RValue, SignedMoney } from "./values";

/** Compact trade rows for the account dashboard (recent and live trades); each row opens the trade. */

const DIRECTION = { LONG: "Long", SHORT: "Short" } as const;
const MODEL = { OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other model" } as const;

export function tradeTitle(row: TradeListRow): string {
  const { symbol, direction } = row.trade;
  const instrument = symbol ?? "Instrument not recorded";
  return direction ? `${instrument} · ${DIRECTION[direction]}` : instrument;
}

function tradeResult(row: TradeListRow, now: string): ReactNode {
  const { trade } = row;
  if (trade.exited_at !== null && trade.net_pnl !== null) {
    return (
      <>
        {trade.realized_r === null ? <span className="t-caption">No R recorded</span> : <RValue value={trade.realized_r} className="font-medium" />}
        <SignedMoney value={trade.net_pnl} currency={trade.currency} className="t-caption" />
      </>
    );
  }
  if (row.state.lifecycle === "LIVE" && trade.entered_at !== null) {
    return <span className="t-caption">Open {formatDuration(trade.entered_at, now)}</span>;
  }
  if (trade.requested_risk_percent !== null) return <span className="t-caption">Planned risk {formatPercent(trade.requested_risk_percent)}</span>;
  return null;
}

export function TradeRows({ rows, display, now, label }: { rows: TradeListRow[]; display: TimeDisplay; now: string; label: string }) {
  return (
    <ul className="-mx-2 flex flex-col" aria-label={label}>
      {rows.map(row => {
        // A custom model (0020) is a journal label, never validated by the Risk Engine.
        const model = row.trade.custom_model_name ? `${row.trade.custom_model_name} (custom)` : row.trade.entry_model ? MODEL[row.trade.entry_model] : null;
        return (
          <li key={row.id} className="border-b border-border last:border-b-0">
            <Link href={row.href} className="group flex min-h-14 items-center gap-3 rounded-control px-2 py-2.5 hover:bg-surface-sunken">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-text">{tradeTitle(row)}</span>
                  {row.state.origin !== "PLANNED" && <Badge>{row.state.originLabel}</Badge>}
                </p>
                <p className="t-caption">
                  {formatDateTime(row.tradeAt, display)}
                  {model && ` · ${model}`}
                </p>
                <span className="sm:hidden">
                  <StatusPill tone={row.state.tone}>{row.state.label}</StatusPill>
                </span>
              </div>
              <StatusPill tone={row.state.tone} className="hidden flex-none sm:inline-flex">
                {row.state.label}
              </StatusPill>
              <div className="flex min-w-20 flex-none flex-col items-end gap-0.5 whitespace-nowrap text-right">{tradeResult(row, now)}</div>
              <ChevronRight aria-hidden="true" className="size-4 flex-none text-text-3 group-hover:text-text-2" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
