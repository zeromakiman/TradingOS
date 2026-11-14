import Decimal from "decimal.js";
import { ChevronRight } from "lucide-react";
import { accountDashboardHref } from "@/components/accounts/copy";
import { formatTickMoney } from "@/components/charts/format";
import { LineChart } from "@/components/charts/line-chart";
import type { ChartDatum } from "@/components/charts/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { SegmentedLinks } from "@/components/ui/choice";
import { cx } from "@/components/ui/cx";
import { Stat } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLink, TableRow } from "@/components/ui/table";
import {
  type BalanceTotal, OVERVIEW_RANGE_LABELS, OVERVIEW_RANGES, type OverviewFigures, type OverviewRange, type OverviewRow, type PnlSeries,
} from "@/domain/all-accounts-overview";
import { formatMoney, formatR, formatSignedMoney, plural } from "@/domain/format";
import { formatDay, formatTime, type TimeDisplay } from "@/domain/time-display";
import type { OverviewState } from "./types";

/**
 * All Accounts overview of Today (V2.1, approved mockup): five stat cards (Total P&L, Total R, Win Rate with W/L,
 * Avg R, Trades), the cumulative P&L chart with D/W/M/Y/All beside "P&L by Account". Money stays in its own currency:
 * P&L reads per currency and the chart draws one currency at a time. Every row adds up to the cards. Server component.
 */

export const OVERVIEW_HEADING_ID = "today-overview-title";
export const BALANCE_CAPTION = "Sum of last recorded balances · not live equity";
const R_NOTE = "R is per-trade risk units, not money.";

const toneClass = (value: string | null): string => {
  if (value === null) return "text-1";
  const decimal = new Decimal(value);
  return decimal.isZero() ? "text-1" : decimal.isNegative() ? "value-neg" : "value-pos";
};

function formatRate(fraction: string | null): string {
  return fraction === null ? "—" : `${new Decimal(fraction).mul(100).toFixed(1)}%`;
}

function overviewHref(range: OverviewRange, currency: string | null): string {
  const params = new URLSearchParams();
  if (range !== "d") params.set("range", range);
  if (currency) params.set("currency", currency);
  const query = params.toString();
  return query ? `/today?${query}` : "/today";
}

/** "recorded Nov 8–Nov 10" (or one day). */
function recordedDays(total: BalanceTotal): string {
  return total.firstDay === total.lastDay ? `recorded ${formatDay(total.firstDay)}` : `recorded ${formatDay(total.firstDay)}–${formatDay(total.lastDay)}`;
}

function periodWords(figures: OverviewFigures): string {
  const label = OVERVIEW_RANGE_LABELS[figures.range].long;
  if (figures.from === null) return `${label}, by exit day (UTC−5)`;
  return figures.from === figures.to ? `${label} · ${formatDay(figures.to)}, by exit day (UTC−5)` : `${label} · ${formatDay(figures.from)}–${formatDay(figures.to)}, by exit day (UTC−5)`;
}

function Cards({ figures }: { figures: OverviewFigures | null }) {
  const unknown = figures === null ? "The overview could not be loaded. Reload the page to try again." : figures.unknownReason;
  const known = figures !== null && unknown === null;
  const pnl = known ? figures.pnl : [];
  const balances = figures?.balances ?? [];
  const excluded = known && figures.excludedNoRiskBasis > 0 ? `${figures.excludedNoRiskBasis} without recorded risk not in R` : null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:gap-4">
      <Card className="col-span-2 sm:col-span-3 lg:col-span-1 border-l-4 border-l-accent">
        <CardBody>
          <Stat
            size="lg"
            label="Total P&L (All Accounts)"
            value={
              !known ? "—" : pnl.length === 0 ? formatSignedMoney("0", balances[0]?.currency ?? "USD") : (
                <span className="flex flex-col">
                  {pnl.map((entry, index) => (
                    <span key={entry.currency} className={cx("num", toneClass(entry.netPnl))}>
                      {index > 0 && <span className="sr-only">, </span>}
                      {entry.netPnl === null ? `— ${entry.currency}` : formatSignedMoney(entry.netPnl, entry.currency)}
                    </span>
                  ))}
                </span>
              )
            }
            hint={
              <span className="flex flex-col gap-0.5">
                {!known && <span>{unknown}</span>}
                {known && pnl.length > 1 && <span>Per currency, never added together. </span>}
                {balances.map(total => (
                  <span key={total.currency}>
                    {formatMoney(total.total, total.currency)} · {BALANCE_CAPTION} · {recordedDays(total)}.{" "}
                  </span>
                ))}
              </span>
            }
          />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat label="Total R" value={<span className={cx("num", known && toneClass(figures.totalR))}>{known ? formatR(figures.totalR) : "—"}</span>} hint={excluded ?? R_NOTE} />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat
            label="Win Rate"
            value={
              <span className="num">
                {known ? formatRate(figures.winRate) : "—"}
                {known && figures.rTrades > 0 && (
                  <>
                    {" "}
                    <span className="ml-1 text-sm font-normal text-2">
                      {figures.wins}W / {figures.losses}L
                    </span>
                  </>
                )}
              </span>
            }
            hint={known ? `N = ${figures.rTrades}` : undefined}
          />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat label="Avg R" value={<span className={cx("num", known && toneClass(figures.averageR))}>{known ? formatR(figures.averageR) : "—"}</span>} />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat label="Trades" value={<span className="num">{known ? figures.trades : "—"}</span>} hint={known ? "Closed in the period" : undefined} />
        </CardBody>
      </Card>
    </div>
  );
}

function chartPoints(series: PnlSeries, display: TimeDisplay): ChartDatum[] {
  return series.points.map(point => ({
    key: point.key,
    label: point.kind === "start" ? "Start" : point.kind === "trade" ? formatTime(point.at as string, display) : formatDay(point.at as string),
    value: point.cumulative,
    valueLabel: formatSignedMoney(point.cumulative, series.currency),
    ...(point.tradeId ? { href: `/trades/${point.tradeId}` } : {}),
    ...(point.trades > 0 ? { detail: plural(point.trades, "trade") } : {}),
  }));
}

const trades = (series: PnlSeries) => series.points.reduce((sum, point) => sum + point.trades, 0);

function PnlChart({ state, display }: { state: OverviewState; display: TimeDisplay }) {
  const figures = state.figures;
  const series = figures?.unknownReason === null ? figures.series : [];
  // The chosen currency, else the one with the most trades in the period (then by code).
  const busiest = [...series].sort((a, b) => trades(b) - trades(a))[0] ?? null;
  const chosen = series.find(entry => entry.currency === state.currency) ?? busiest;
  const ranges = (
    <SegmentedLinks
      label="Period"
      size="sm"
      items={OVERVIEW_RANGES.map(range => ({ label: OVERVIEW_RANGE_LABELS[range].short, href: overviewHref(range, state.currency), current: range === state.range }))}
    />
  );
  const currencies = series.length > 1 ? (
    <SegmentedLinks
      label="Chart currency"
      size="sm"
      items={series.map(entry => ({ label: entry.currency, href: overviewHref(state.range, entry.currency), current: entry.currency === chosen?.currency }))}
    />
  ) : null;
  return (
    <Card className="min-w-0 lg:col-span-7">
      <CardBody>
        <LineChart
          headingLevel={3}
          title="Total P&L (All Accounts)"
          question={figures ? periodWords(figures) : "Cumulative net P&L of the period"}
          sample={chosen ? `${chosen.currency} accounts · cumulative net P&L${series.length > 1 ? " · one currency at a time" : ""}` : undefined}
          actions={<div className="flex flex-wrap items-center gap-2">{currencies}{ranges}</div>}
          series={chosen && !chosen.incomplete && chosen.points.length > 1 ? [{ id: `pnl-${chosen.currency}`, name: `Cumulative P&L (${chosen.currency})`, points: chartPoints(chosen, display) }] : []}
          xLabel={state.range === "d" ? "Exit" : "Day"}
          formatTick={chosen ? formatTickMoney(chosen.currency) : undefined}
          empty={
            figures?.unknownReason
              ? { title: "Figures not shown", description: figures.unknownReason }
              : chosen?.incomplete
                ? { title: "Not charted", description: "A closed trade of this currency has no recorded P&L." }
                : { title: "No trades closed in this period.", description: "The line starts once a trade of any account is closed." }
          }
        />
      </CardBody>
    </Card>
  );
}

function rowPnl(row: OverviewRow): { text: string; tone: string } {
  if (row.netPnl === null) return { text: "—", tone: "text-3" };
  return { text: row.trades === 0 ? formatMoney("0", row.account.currency) : formatSignedMoney(row.netPnl, row.account.currency), tone: toneClass(row.netPnl) };
}

function AccountsTable({ figures }: { figures: OverviewFigures | null }) {
  const rows = figures?.rows ?? [];
  const known = figures !== null && figures.unknownReason === null;
  return (
    <Card as="section" aria-labelledby="today-overview-accounts" className="min-w-0 lg:col-span-5">
      <CardHeader>
        <CardTitle as="h3" id="today-overview-accounts">
          P&L by Account
        </CardTitle>
      </CardHeader>
      <CardBody>
        {rows.length === 0 ? (
          <p className="t-meta">No active trading accounts.</p>
        ) : (
          <Table
            caption="P&L by account in the period"
            cards
            className="text-sm md:[&_td]:px-2 md:[&_th]:px-2 md:[&_td:first-child]:pl-3 md:[&_th:first-child]:pl-3"
          >
            <TableHead>
              <TableRow>
                <TableHeaderCell>Account</TableHeaderCell>
                <TableHeaderCell align="end">P&L</TableHeaderCell>
                <TableHeaderCell align="end">R</TableHeaderCell>
                <TableHeaderCell align="end">Trades</TableHeaderCell>
                <TableHeaderCell align="end">Win rate</TableHeaderCell>
                <TableHeaderCell align="end">
                  <span className="sr-only">Open</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(row => {
                const pnl = rowPnl(row);
                const href = accountDashboardHref(row.account);
                return (
                  <TableRow key={row.account.id} interactive>
                    <TableCell primary className="max-w-36 xl:max-w-44">
                      <TableLink href={href} className="flex min-w-0 items-center gap-2">
                        <span aria-hidden="true" className={cx("size-2 flex-none rounded-full", row.trades > 0 ? "bg-accent" : "bg-border-strong")} />
                        <span className="truncate" title={row.account.name}>
                          {row.account.name}
                        </span>{" "}
                        <span className="hidden flex-none text-xs font-normal text-3 2xl:inline">{row.account.currency}</span>
                      </TableLink>
                      {row.account.status === "ARCHIVED" && <Badge className="ml-4">Archived</Badge>}
                    </TableCell>
                    <TableCell align="end" label="P&L" className={cx("num", known && pnl.tone)}>{known ? pnl.text : "—"}</TableCell>
                    <TableCell align="end" label="R" className="num">{known ? formatR(row.netR) : "—"}</TableCell>
                    <TableCell align="end" label="Trades" className="num">{known ? row.trades : "—"}</TableCell>
                    <TableCell align="end" label="Win Rate" className="num">{known ? formatRate(row.winRate) : "—"}</TableCell>
                    <TableCell align="end" className="w-8">
                      <TableLink href={href} aria-label={`Open ${row.account.name}`} className="inline-flex text-3">
                        <ChevronRight aria-hidden="true" className="size-4" />
                      </TableLink>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

export function AllAccountsOverview({ state, display }: { state: OverviewState; display: TimeDisplay }) {
  return (
    <section aria-labelledby={OVERVIEW_HEADING_ID} className="flex flex-col gap-3 lg:gap-4">
      <h2 id={OVERVIEW_HEADING_ID} className="sr-only">
        All Accounts overview
      </h2>
      {state.figures === null && (
        <Callout tone="negative" role="alert">
          The All Accounts overview could not be loaded. Reload the page to try again; the rest of Today is current.
        </Callout>
      )}
      <Cards figures={state.figures} />
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-12 lg:gap-4">
        <PnlChart state={state} display={display} />
        <AccountsTable figures={state.figures} />
      </div>
    </section>
  );
}
