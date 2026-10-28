import Decimal from "decimal.js";
import { BookOpen, ChartNoAxesCombined, ChevronLeft, CircleAlert, CircleCheck, Info, OctagonAlert, Plus, Settings2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BALANCE_FROM_TRADES_LABEL } from "@/domain/account-metrics";
import type { DailyAction, DailyStatus } from "@/domain/daily-status";
import { formatMoney, formatR, formatSignedMoney, plural } from "@/domain/format";
import { type CalendarMode, sampleCaveat } from "@/domain/performance";
import { formatDateTime, formatDay, strategyDay, strategyDayLabel, type TimeDisplay } from "@/domain/time-display";
import { DivergingBarChart } from "@/components/charts/bar-chart";
import { CalendarHeatmap } from "@/components/charts/calendar-heatmap";
import { formatTickMoney, formatTickR } from "@/components/charts/format";
import { HBarChart } from "@/components/charts/hbar-chart";
import { DrawdownChart, LineChart } from "@/components/charts/line-chart";
import type { CalendarHeatmapDay, ChartDatum } from "@/components/charts/types";
import { StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { edgeAccountHistoryHref } from "@/components/edge/query";
import type { AccountDashboard } from "@/lib/accounts-data";
import { accountHistoryDrill, accountHistoryJournalHref, breakdownHref, closedOnHref, type DrillDown, tradeHref } from "@/lib/performance-data";
import { ConfirmUnchangedButton } from "./account-values-forms";
import { connectionLabel } from "./accounts-overview";
import { ContextSwitchScope } from "./context-switch-scope";
import { ARCHIVED_DASHBOARD_COPY, manageHref, typeAndBroker } from "./copy";
import { RiskPlanTable } from "./risk-plan-table";
import { TradeRows } from "./trade-rows";
import { HIT_AREA, KnownValue, Money, RValue, SignedMoney, STAT_GRID_4, STAT_GRID_5, TEXT_LINK } from "./values";

/**
 * Account dashboard (docs/V2_ARCHITECTURE.md §9.4, §13.6, §14.8): what the trader recorded and what the account's
 * closed trades add up to, in the account's own currency. Every chart answers one question, has a table view and
 * drills into trades (points open the trade; days open the Journal filtered to that day). Live trades move to the top
 * while any exist (the next action, as on Today §14.1). An archived account can't be the working context (§9.2), so its
 * dashboard never links to a switch to it: its Journal, EDGE and drill-down links open All Accounts with the read-only
 * account filter instead (`historyLinks`).
 */

const D = Decimal.clone({ precision: 100 });
/** The daily P&L bars stay readable: the most recent trading days with exits. */
export const DAILY_DAYS = 30;

export const CALENDAR_MODE_PARAMS: Readonly<Record<CalendarMode, string>> = Object.freeze({ NET_R: "net-r", NET_PNL: "net-pnl", GROSS_LOSS: "loss", COUNT: "trades" });
const CALENDAR_MODE_LABELS: Readonly<Record<CalendarMode, string>> = Object.freeze({ NET_R: "Net R", NET_PNL: "Net P&L", GROSS_LOSS: "Loss", COUNT: "Trades" });
const CALENDAR_VALUE_NAMES: Readonly<Record<CalendarMode, string>> = Object.freeze({ NET_R: "Net R", NET_PNL: "Net P&L", GROSS_LOSS: "Gross realized loss", COUNT: "Closed trades" });

export function parseCalendarMode(value: string | string[] | undefined): CalendarMode {
  const text = Array.isArray(value) ? value[0] : value;
  const entry = Object.entries(CALENDAR_MODE_PARAMS).find(([, param]) => param === text);
  return (entry?.[0] as CalendarMode | undefined) ?? "NET_R";
}

export function dashboardHref(accountId: string, month: string, mode: CalendarMode): string {
  const params = new URLSearchParams({ month });
  if (mode !== "NET_R") params.set("mode", CALENDAR_MODE_PARAMS[mode]);
  return `/accounts/${accountId}?${params.toString()}#calendar`;
}

export interface AccountDashboardViewProps {
  dashboard: AccountDashboard;
  display: TimeDisplay;
  month: string;
  mode: CalendarMode;
  /** The header's trading-account context of this request: `all` or an account id (see ContextSwitchScope). */
  currentContext: string;
}

/**
 * The account's Journal and EDGE: an active account becomes the context (the data layer's links); an archived one,
 * which can never be the context (§9.2), opens in All Accounts with the read-only account filter.
 */
function historyLinks(dashboard: AccountDashboard): { journal: string; edge: string; manage: string } {
  const { account, links } = dashboard;
  if (account.status !== "ARCHIVED") return links;
  return { journal: accountHistoryJournalHref(account.id), edge: edgeAccountHistoryHref(account.id), manage: links.manage };
}

// ---------------------------------------------------------------------------------------------------------
// Header and today's status.
// ---------------------------------------------------------------------------------------------------------
function DashboardHeader({ dashboard, display }: { dashboard: AccountDashboard; display: TimeDisplay }) {
  const { account, metrics } = dashboard;
  const links = historyLinks(dashboard);
  const archived = account.status === "ARCHIVED";
  const parts = [typeAndBroker(account.type, account.broker), metrics.platform.label, connectionLabel(dashboard.connection, display), account.currency];
  return (
    <PageHeader
      className="mb-0"
      eyebrow={
        <Link href="/accounts" className="inline-flex min-h-10 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Accounts
        </Link>
      }
      title={account.name}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{[...new Set(parts)].join(" · ")}</span>
          {archived && <StatusPill tone="muted">Archived</StatusPill>}
        </span>
      }
      actions={
        <>
          <Link href={links.journal} prefetch={false} className={buttonClasses({ variant: "secondary" })}>
            <BookOpen aria-hidden="true" />
            Journal
          </Link>
          <Link href={links.manage} className={buttonClasses({ variant: "secondary" })}>
            <Settings2 aria-hidden="true" />
            Manage
          </Link>
        </>
      }
    />
  );
}

function actionHref(action: DailyAction, dashboard: AccountDashboard): string {
  switch (action.kind) {
    case "CONFIRM_ACCOUNT_VALUES":
      return manageHref(dashboard.account.id, "account-values");
    case "ADD_EXTERNAL_LOSS":
      return manageHref(dashboard.account.id, "external-losses");
    case "ADD_ENTRY_DETAILS":
      return "#live-trades";
    case "REFRESH":
      return `/accounts/${dashboard.account.id}`;
  }
}

const TODAY_HEADING = "account-today";

/** "Used today: 1 planned · 0 recorded live", each count kept with its words when the hint wraps on a phone. */
function usedToday(planned: number, unplanned: number): string {
  return `Used today: ${planned}\u00a0planned · ${unplanned}\u00a0recorded\u00a0live`;
}

function TodayCard({ dashboard, status }: { dashboard: AccountDashboard; status: DailyStatus }) {
  const { workspace, account } = dashboard;
  const observation = workspace.observation;
  const needsConfirmation = !status.stale && !status.stats.accountValues.confirmedToday;
  return (
    <Card as="section" aria-labelledby={TODAY_HEADING}>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle id={TODAY_HEADING}>Today on this account</CardTitle>
          <p className="t-caption">{strategyDayLabel(status.day)}</p>
        </div>
        <StatusPill tone={status.tone} icon={status.tone === "positive" ? <CircleCheck aria-hidden="true" className="size-3.5" /> : <CircleAlert aria-hidden="true" className="size-3.5" />}>
          {status.headline}
        </StatusPill>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {status.stats && (
          <div className={STAT_GRID_4}>
            <Stat label="Trades left" value={status.stats.trades.label} hint={usedToday(status.stats.trades.planned, status.stats.trades.unplanned)} />
            <Stat label="Daily risk" value={status.stats.risk.label} hint={status.stats.risk.cap ? `Cap ${formatMoney(status.stats.risk.cap, account.currency)}` : "Set a cap in Risk policy"} />
            <Stat
              label="Realized losses today"
              value={formatMoney(status.stats.losses.total, account.currency)}
              hint={
                <>
                  {!new D(status.stats.losses.external).isZero() && `Includes ${formatMoney(status.stats.losses.external, account.currency)} external · `}
                  <Link href={manageHref(account.id, "external-losses")} className={cx("text-accent hover:underline", HIT_AREA)}>
                    Add external loss
                  </Link>
                </>
              }
            />
            <Stat
              label="Account values"
              value={status.stats.accountValues.confirmedToday ? "Confirmed" : "Not confirmed"}
              hint={status.stats.accountValues.label}
            />
          </div>
        )}
        {status.reasons.length > 0 && (
          <ul className="flex flex-col gap-2">
            {status.reasons.map(reason => (
              <li key={reason.code} className="flex items-start gap-2 text-sm">
                {reason.severity === "BLOCK" ? (
                  <OctagonAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-neg" />
                ) : (
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-warn" />
                )}
                <span className="min-w-0">
                  <span className="sr-only">{reason.severity === "BLOCK" ? "Blocks new plans: " : "Warning: "}</span>
                  {reason.message}
                  {reason.action && reason.action.kind !== "CONFIRM_ACCOUNT_VALUES" && (
                    <>
                      {" "}
                      <Link href={actionHref(reason.action, dashboard)} className={cx("font-medium text-accent hover:underline", HIT_AREA)}>
                        {reason.action.label}
                      </Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {needsConfirmation && observation && (
          <div className="flex flex-wrap items-center gap-3 rounded-control bg-surface-sunken p-3">
            <p className="min-w-0 flex-1 text-sm">
              Last recorded {formatDay(observation.tradingDay)}: balance <Money value={observation.balance} currency={account.currency} className="font-medium" />, equity{" "}
              <Money value={observation.equity} currency={account.currency} className="font-medium" />.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ConfirmUnchangedButton accountId={account.id} observationId={observation.id} focusAfter={TODAY_HEADING} />
              <Link href={manageHref(account.id, "account-values")} className={buttonClasses({ variant: "ghost" })}>
                Enter new values
              </Link>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Value and result cards.
// ---------------------------------------------------------------------------------------------------------
/** `Recorded today` or `Recorded Oct 16` (strategy day of the values). */
export function recordedOn(day: string, today: string): string {
  return day === today ? "Recorded today" : `Recorded ${formatDay(day, undefined, { year: day.slice(0, 4) !== today.slice(0, 4) })}`;
}

function ValueCards({ dashboard }: { dashboard: AccountDashboard }) {
  const { metrics } = dashboard;
  const currency = metrics.currency;
  const today = strategyDay(dashboard.now);
  return (
    <Card as="section" aria-labelledby="account-values-heading">
      <CardHeader>
        <CardTitle id="account-values-heading">Account values</CardTitle>
        {dashboard.account.status === "ACTIVE" && (
          <Link href={manageHref(dashboard.account.id, "account-values")} className={TEXT_LINK}>
            Update values
          </Link>
        )}
      </CardHeader>
      <CardBody>
        <div className={STAT_GRID_5}>
          <Stat
            label="Recorded balance"
            value={<KnownValue known={metrics.lastBalance} render={value => formatMoney(value.amount, currency)} />}
            hint={metrics.lastBalance.value ? recordedOn(metrics.lastBalance.value.day, today) : metrics.lastBalance.unknownReason}
          />
          <Stat
            label="Recorded equity"
            value={<KnownValue known={metrics.lastEquity} render={value => formatMoney(value.amount, currency)} />}
            hint={metrics.lastEquity.value ? recordedOn(metrics.lastEquity.value.day, today) : metrics.lastEquity.unknownReason}
          />
          <Stat
            label="Starting balance"
            value={<KnownValue known={metrics.startingBalance} render={value => formatMoney(value, currency)} />}
            hint={metrics.startingBalance.value === null ? metrics.startingBalance.unknownReason : "As set in the profile"}
          />
          <Stat label="Realized P&L" value={<SignedMoney value={metrics.realizedPnl} currency={currency} />} hint={`${plural(metrics.closedCount, "closed trade")} in Trading OS`} />
          <Stat
            label="Balance from trades"
            value={<KnownValue known={metrics.balanceFromTrades} render={value => formatMoney(value, currency)} />}
            hint={metrics.balanceFromTrades.value === null ? metrics.balanceFromTrades.unknownReason : BALANCE_FROM_TRADES_LABEL}
          />
        </div>
      </CardBody>
    </Card>
  );
}

function ResultCards({ dashboard }: { dashboard: AccountDashboard }) {
  const { metrics } = dashboard;
  return (
    <Card as="section" aria-labelledby="account-results-heading">
      <CardHeader>
        <CardTitle id="account-results-heading">Results</CardTitle>
        <p className="t-caption">{sampleCaveat(metrics.rTrades)}</p>
      </CardHeader>
      <CardBody>
        <div className={STAT_GRID_5}>
          <Stat label="Today" value={<SignedMoney value={metrics.todayPnl} currency={metrics.currency} />} hint="Trades closed today (UTC−5)" />
          <Stat label="This month" value={<SignedMoney value={metrics.monthPnl} currency={metrics.currency} />} hint="Trades closed this month" />
          <Stat
            label="Cumulative R"
            value={<KnownValue known={metrics.cumulativeR} render={value => <RValue value={value} />} />}
            hint={
              metrics.excludedNoRiskBasis > 0
                ? `${plural(metrics.rTrades, "trade")} with R · ${metrics.excludedNoRiskBasis} without recorded risk`
                : `${plural(metrics.rTrades, "trade")} with R`
            }
          />
          <Stat
            label="Max R drawdown"
            value={<KnownValue known={metrics.maxDrawdownR} render={value => <RValue value={new D(value).isZero() ? "0" : new D(value).neg().toFixed()} />} />}
            hint="Largest fall from a cumulative R peak"
          />
          <Stat label="Trades" value={<span className="num">{metrics.closedCount} closed</span>} hint={metrics.openCount ? `${metrics.openCount} live now` : "None live now"} />
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Charts.
// ---------------------------------------------------------------------------------------------------------
function ChartCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

const NO_R_EMPTY = { title: "No closed trades with a recorded risk yet.", description: "Plan or record a trade on this account; R results appear here after you close it." };

/**
 * Day and group drill-downs open the Journal in this account's context (`href`, from the data layer). An archived
 * account can't be that context (the switch would be refused and the Journal would list every account), so its
 * drill-downs open All Accounts with the read-only account filter (`history`, given that drill-down).
 */
function journalDrill(dashboard: AccountDashboard, href: string | null, history: (drill: DrillDown) => string | null): string | undefined {
  if (href === null) return undefined;
  return dashboard.account.status === "ARCHIVED" ? (history(accountHistoryDrill(dashboard.account.id)) ?? undefined) : href;
}

function DashboardCharts({ dashboard, display }: { dashboard: AccountDashboard; display: TimeDisplay }) {
  const { metrics, account } = dashboard;
  const currency = account.currency;
  const hasR = dashboard.curve.length > 1;
  const rSample = `${plural(metrics.rTrades, "trade")} with R${metrics.excludedNoRiskBasis ? ` · ${metrics.excludedNoRiskBasis} without recorded risk not shown` : ""}`;
  // Axis labels stay short (the exit day); the tooltip names the trade.
  const tradeLabel = (sequence: number, at: string | null) => (sequence === 0 ? "Start" : at ? formatDay(at, display) : `Trade ${sequence}`);
  const tradeNote = (sequence: number, extra?: string) => [sequence === 0 ? null : `Trade ${sequence}`, extra].filter(Boolean).join(" · ") || undefined;

  const balance: ChartDatum[] = (dashboard.balanceCurve ?? []).length > 1
    ? (dashboard.balanceCurve ?? []).map(point => ({
        key: `${point.sequence}`,
        label: tradeLabel(point.sequence, point.at),
        value: point.balance,
        valueLabel: formatMoney(point.balance, currency),
        href: point.tradeId ? tradeHref(point.tradeId) : undefined,
        detail: point.at ? tradeNote(point.sequence, `closed ${formatDateTime(point.at, display)}`) : "Starting balance",
      }))
    : [];
  const cumulative: ChartDatum[] = hasR
    ? dashboard.curve.map(point => ({
        key: `${point.sequence}`,
        label: tradeLabel(point.sequence, point.at),
        value: point.cumulativeR,
        valueLabel: formatR(point.cumulativeR),
        href: point.tradeId ? tradeHref(point.tradeId) : undefined,
        detail: tradeNote(point.sequence, point.r === null ? undefined : `result ${formatR(point.r)}`),
      }))
    : [];
  const drawdown = hasR
    ? dashboard.drawdown.map(point => ({
        key: `${point.sequence}`,
        label: tradeLabel(point.sequence, point.at),
        value: point.drawdownR,
        href: point.tradeId ? tradeHref(point.tradeId) : undefined,
        detail: tradeNote(point.sequence),
      }))
    : [];
  const recentDays = dashboard.daily.slice(-DAILY_DAYS);
  const daily: ChartDatum[] = recentDays.map(point => {
    const money = point.money.find(entry => entry.currency === currency);
    return {
      key: point.day,
      label: formatDay(point.day),
      value: money?.netPnl ?? null,
      valueLabel: money ? formatSignedMoney(money.netPnl, currency) : "—",
      href: journalDrill(dashboard, point.href, drill => closedOnHref(point.day, drill)),
      detail: `${plural(point.closed, "trade")}${point.netR !== null ? ` · ${formatR(point.netR)}` : ""}`,
    };
  });
  const dailySample = dashboard.daily.length > DAILY_DAYS ? `Last ${DAILY_DAYS} of ${dashboard.daily.length} trading days with exits` : plural(dashboard.daily.length, "trading day");

  return (
    <section aria-labelledby="account-charts" className="flex flex-col">
      <SectionHeader id="account-charts" title="Performance" description="Click a point to open its trade, or a day to list its trades in the Journal." />
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard>
          <LineChart
            title="Balance from trades"
            question="How has the account grown from closed trades?"
            sample={`${BALANCE_FROM_TRADES_LABEL} · ${plural(metrics.closedCount, "closed trade")} · ${currency}`}
            series={[{ id: "balance", name: "Balance from trades", points: balance }]}
            includeZero={false}
            xLabel="Trade"
            formatTick={formatTickMoney(currency)}
            empty={
              dashboard.balanceCurve === null
                ? {
                    title: "Needs a starting balance.",
                    description: "Trading OS does not estimate one. Add the starting balance in Manage → Profile.",
                    actions: (
                      <Link href={manageHref(account.id)} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                        Add starting balance
                      </Link>
                    ),
                  }
                : { title: "No closed trades yet.", description: "The line starts at the starting balance and moves with each closed trade's net P&L." }
            }
          />
        </ChartCard>
        <ChartCard>
          <LineChart
            title="Cumulative R"
            question="Is the process compounding?"
            sample={rSample}
            series={[{ id: "cumulative-r", name: "Cumulative R", points: cumulative }]}
            xLabel="Trade"
            formatTick={formatTickR}
            empty={NO_R_EMPTY}
          />
        </ChartCard>
        <ChartCard>
          <DrawdownChart title="R drawdown" question="Where am I giving profits back?" sample={rSample} points={drawdown} xLabel="Trade" formatTick={formatTickR} empty={NO_R_EMPTY} />
        </ChartCard>
        <ChartCard>
          <DivergingBarChart
            title="Daily P&L"
            question="Which days drive results?"
            sample={`${dailySample} · ${currency} · UTC−5 strategy days`}
            data={daily}
            valueName="Net P&L"
            categoryLabel="Day"
            formatTick={formatTickMoney(currency)}
            empty={{ title: "No closed trades yet.", description: "Each bar is one trading day's net P&L once trades close." }}
          />
        </ChartCard>
      </div>
    </section>
  );
}

function CalendarSection({ dashboard, month, mode }: { dashboard: AccountDashboard; month: string; mode: CalendarMode }) {
  const { calendar, account } = dashboard;
  const today = strategyDay(dashboard.now);
  const days: CalendarHeatmapDay[] = calendar.days
    .filter(day => day.inMonth)
    .map(day => ({
      day: day.day,
      value: day.value,
      href: journalDrill(dashboard, day.href, drill => closedOnHref(day.day, drill)),
      detail: day.closed ? plural(day.closed, "closed trade") : undefined,
    }));
  const modeLinks = (Object.keys(CALENDAR_MODE_LABELS) as CalendarMode[]).map(item => ({
    href: dashboardHref(account.id, month, item),
    label: CALENDAR_MODE_LABELS[item],
    current: item === mode,
  }));
  const nextAllowed = calendar.nextMonth <= today.slice(0, 7);
  return (
    <section id="calendar" aria-label="Calendar" className="scroll-mt-20">
      <Card>
        <CardBody>
          <CalendarHeatmap
            title="Calendar"
            question="When am I winning or losing?"
            sample={`${plural(calendar.closed, "closed trade")} this month · ${mode === "NET_PNL" || mode === "GROSS_LOSS" ? `${account.currency} · ` : ""}UTC−5 strategy days`}
            month={month}
            mode={mode}
            currency={account.currency}
            valueName={CALENDAR_VALUE_NAMES[mode]}
            days={days}
            today={today}
            modeLinks={modeLinks}
            previousMonth={{ href: dashboardHref(account.id, calendar.previousMonth, mode), label: "Previous month" }}
            nextMonth={nextAllowed ? { href: dashboardHref(account.id, calendar.nextMonth, mode), label: "Next month" } : undefined}
            emptyNote="No trades closed on this account this month."
          />
        </CardBody>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Trades, breakdowns, risk plans, links.
// ---------------------------------------------------------------------------------------------------------
/** Open positions of the account: each row opens the trade, where it is journaled and closed. */
function LiveTradesCard({ dashboard, display }: { dashboard: AccountDashboard; display: TimeDisplay }) {
  const { liveTrades } = dashboard;
  return (
    <Card as="section" aria-labelledby="live-trades" className="scroll-mt-20">
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle id="live-trades">Live trades</CardTitle>
          {liveTrades.length > 0 && <p className="t-caption">Open a trade to add to its journal or close it.</p>}
        </div>
        {liveTrades.length > 0 && <StatusPill tone="live">{liveTrades.length} live</StatusPill>}
      </CardHeader>
      <CardBody>
        {liveTrades.length ? (
          <TradeRows rows={liveTrades} display={display} now={dashboard.now} label="Live trades" />
        ) : (
          <p className="t-meta">No live trades on this account. Trades appear here from their entry until you close them.</p>
        )}
      </CardBody>
    </Card>
  );
}

/** Recent trades, next to the (empty) live trades card unless live trades are already shown at the top. */
function TradesSection({ dashboard, display, withLive }: { dashboard: AccountDashboard; display: TimeDisplay; withLive: boolean }) {
  const { recentTrades } = dashboard;
  return (
    <div className={cx("grid items-start gap-4", withLive && "lg:grid-cols-2")}>
      {withLive && <LiveTradesCard dashboard={dashboard} display={display} />}
      <Card as="section" aria-labelledby="recent-trades">
        <CardHeader>
          <CardTitle id="recent-trades">Recent trades</CardTitle>
          <Link href={historyLinks(dashboard).journal} prefetch={false} className={TEXT_LINK}>
            All in Journal
          </Link>
        </CardHeader>
        <CardBody>
          {recentTrades.length ? (
            <TradeRows rows={recentTrades} display={display} now={dashboard.now} label="Recent trades" />
          ) : (
            <EmptyState compact title="No trades on this account yet." description="Plan a trade or record a live one; it appears here right away." />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/** Words for the group of trades without the dimension (the domain's "Unknown"). */
const MISSING_GROUP = { model: "Model not recorded", session: "Entry time not recorded" } as const;

function breakdownData(dashboard: AccountDashboard, groups: AccountDashboard["breakdowns"]["model"], missing: string): ChartDatum[] {
  return groups.map(group => ({
    key: group.value ?? "unknown",
    label: group.value === null ? missing : group.label,
    value: group.metrics.netR,
    valueLabel: group.metrics.netR === null ? "—" : formatR(group.metrics.netR),
    href: journalDrill(dashboard, group.href, drill => breakdownHref(group, drill)),
    detail: `${plural(group.closed, "trade")}${group.evidenceLabel ? ` · ${group.evidenceLabel.toLowerCase()}` : ""}`,
  }));
}

function BreakdownSection({ dashboard }: { dashboard: AccountDashboard }) {
  const empty = { title: "No closed trades yet.", description: "Groups appear once trades on this account are closed." };
  return (
    <section aria-labelledby="account-breakdowns" className="flex flex-col">
      <SectionHeader
        id="account-breakdowns"
        title="Model and session"
        description="Net R per group. Groups below 30 trades show a tendency at most; below 10 the evidence is insufficient."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard>
          <HBarChart title="By model" question="Which entry model performs?" data={breakdownData(dashboard, dashboard.breakdowns.model, MISSING_GROUP.model)} categoryLabel="Model" valueName="Net R" empty={empty} />
        </ChartCard>
        <ChartCard>
          <HBarChart title="By session" question="Which session performs?" data={breakdownData(dashboard, dashboard.breakdowns.session, MISSING_GROUP.session)} categoryLabel="Session" valueName="Net R" empty={empty} />
        </ChartCard>
      </div>
    </section>
  );
}

/** The versions that apply today or later; earlier ones stay one click away. */
function RiskPlanHistory({ plans, currency }: { plans: AccountDashboard["riskPlans"]; currency: string }) {
  const current = plans.filter(plan => plan.status === "ACTIVE" || plan.status === "SCHEDULED");
  const earlier = plans.filter(plan => plan.status !== "ACTIVE" && plan.status !== "SCHEDULED");
  return (
    <div className="flex flex-col gap-3">
      <RiskPlanTable plans={current} currency={currency} />
      {earlier.length > 0 && (
        <Disclosure summary={`Earlier versions · ${earlier.length}`} bodyClassName="pt-1">
          <RiskPlanTable plans={earlier} currency={currency} />
        </Disclosure>
      )}
    </div>
  );
}

/** One explanation instead of six empty charts while the account has no closed trade. */
function NoResultsYet({ dashboard }: { dashboard: AccountDashboard }) {
  const { account } = dashboard;
  return (
    <Card as="section" aria-labelledby="no-results">
      <CardBody>
        <EmptyState
          icon={<ChartNoAxesCombined />}
          headingLevel={2}
          title={<span id="no-results">No closed trades on this account yet.</span>}
          description="Balance from trades, cumulative R, drawdown, daily P&L, the calendar and the model and session groups appear after the first trade is closed."
          actions={
            account.status === "ACTIVE" ? (
              <>
                <Link href={`/trades/new?account=${account.id}`} prefetch={false} className={buttonClasses({ variant: "primary" })}>
                  <Plus aria-hidden="true" />
                  Plan trade
                </Link>
                <Link href={`/trades/live/new?account=${account.id}`} prefetch={false} className={buttonClasses({ variant: "secondary" })}>
                  <Plus aria-hidden="true" />
                  Record live trade
                </Link>
              </>
            ) : undefined
          }
        />
      </CardBody>
    </Card>
  );
}

function QuickLinks({ dashboard }: { dashboard: AccountDashboard }) {
  const links = historyLinks(dashboard);
  const items = [
    { href: links.journal, icon: <BookOpen aria-hidden="true" />, title: "Journal", description: "Every trade of this account, with filters and search.", prefetch: false },
    { href: links.edge, icon: <ChartNoAxesCombined aria-hidden="true" />, title: "EDGE", description: "Statistics, calendar and breakdowns for this account.", prefetch: false },
    { href: links.manage, icon: <Settings2 aria-hidden="true" />, title: "Manage", description: "Profile, values, external losses, risk policy, instruments.", prefetch: true },
  ];
  return (
    <nav aria-label="Account links" className="grid gap-3 sm:grid-cols-3">
      {items.map(item => (
        <Link
          key={item.title}
          href={item.href}
          prefetch={item.prefetch ? undefined : false}
          className="card flex items-start gap-3 p-4 text-text no-underline transition-colors hover:border-border-strong hover:bg-surface-sunken"
        >
          <span className="flex size-8 flex-none items-center justify-center rounded-control bg-accent-soft text-accent [&_svg]:size-4">{item.icon}</span>
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{item.title}</span>
            <span className="t-caption">{item.description}</span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

export function AccountDashboardView({ dashboard, display, month, mode, currentContext }: AccountDashboardViewProps) {
  const { account, workspace } = dashboard;
  const archived = account.status === "ARCHIVED";
  const liveFirst = dashboard.liveTrades.length > 0;
  return (
    <ContextSwitchScope current={currentContext} className="flex flex-col gap-6">
      <DashboardHeader dashboard={dashboard} display={display} />
      {archived && (
        <Callout
          tone="neutral"
          title="This account is archived."
          action={
            <Link href={dashboard.links.manage} className={buttonClasses({ variant: "secondary", size: "sm" })}>
              Restore in Manage
            </Link>
          }
        >
          {ARCHIVED_DASHBOARD_COPY}
        </Callout>
      )}
      {!archived && workspace.gaps.includes("INSTRUMENTS") && (
        <Callout
          tone="warning"
          title="No instruments yet."
          action={
            <Link href={manageHref(account.id, "instruments")} className={buttonClasses({ variant: "secondary", size: "sm" })}>
              Add an instrument
            </Link>
          }
        >
          Plans need at least one instrument with its tick size and tick value in {account.currency}.
        </Callout>
      )}
      {!archived && workspace.status && <TodayCard dashboard={dashboard} status={workspace.status} />}
      {liveFirst && <LiveTradesCard dashboard={dashboard} display={display} />}
      <ValueCards dashboard={dashboard} />
      {dashboard.metrics.closedCount > 0 && <ResultCards dashboard={dashboard} />}
      {dashboard.metrics.closedCount > 0 ? (
        <>
          <DashboardCharts dashboard={dashboard} display={display} />
          <CalendarSection dashboard={dashboard} month={month} mode={mode} />
          <TradesSection dashboard={dashboard} display={display} withLive={!liveFirst} />
          <BreakdownSection dashboard={dashboard} />
        </>
      ) : (
        <>
          <NoResultsYet dashboard={dashboard} />
          {dashboard.recentTrades.length > 0 && <TradesSection dashboard={dashboard} display={display} withLive={!liveFirst} />}
        </>
      )}
      <section aria-labelledby="risk-plan-history" className="flex flex-col">
        <SectionHeader
          id="risk-plan-history"
          title="Risk plan history"
          description="Each trade keeps the risk plan version it was checked with."
          actions={
            <Link href={manageHref(account.id, "risk-policy")} className={cx(buttonClasses({ variant: "ghost", size: "sm" }))}>
              Change risk policy
            </Link>
          }
        />
        <RiskPlanHistory plans={dashboard.riskPlans} currency={account.currency} />
      </section>
      {dashboard.truncated && (
        <Callout tone="info" icon={<Info aria-hidden="true" />}>
          This account has more trades than one page can analyse. Charts show the first 20,000; open EDGE for filtered views.
        </Callout>
      )}
      <QuickLinks dashboard={dashboard} />
    </ContextSwitchScope>
  );
}
