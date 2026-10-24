import { Layers, Plus, TriangleAlert, Wallet } from "lucide-react";
import Link from "next/link";
import type { AccountMetrics, CurrencyTotals } from "@/domain/account-metrics";
import { plural } from "@/domain/format";
import { formatDateTime, formatDay, strategyDay, type TimeDisplay } from "@/domain/time-display";
import { StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/table";
import type { AccountsOverview, AccountSummary } from "@/lib/accounts-data";
import type { AccountConnectionState } from "@/lib/sync-service";
import { AccountRowMenu } from "./account-status-actions";
import { ACTIVE_ACCOUNTS_HEADING, R_UNITS_NOTE, typeAndBroker } from "./copy";
import { KnownValue, Money, RValue, SignedMoney, sumDecimals, UnknownValue } from "./values";

/**
 * Accounts workspace (docs/V2_ARCHITECTURE.md §9.3–9.4, §14.7): one row per trading account with what the trader
 * recorded (balance, equity, with their date) and what Trading OS computed from closed trades (today, this month,
 * cumulative R). Money is totalled only within one currency; balances and equity are never summed across accounts.
 */

export interface AccountsOverviewViewProps {
  overview: AccountsOverview;
  display: TimeDisplay;
}

/** "Manual", "Connected", "Last synced Oct 14, 09:42", "Sync error". */
export function connectionLabel(connection: AccountConnectionState, display: TimeDisplay): string {
  switch (connection.mode) {
    case "MANUAL":
      return "Manual";
    case "PENDING":
      return "Connecting";
    case "CONNECTED":
      return "Connected";
    case "SYNCING":
      return "Syncing";
    case "SYNCED":
      return connection.lastSyncedAt ? `Last synced ${formatDateTime(connection.lastSyncedAt, display)}` : "Connected";
    case "ERROR":
      return "Sync error";
  }
}

/** `today` or `Oct 16` (with the year when it differs). */
function recordedDay(day: string, today: string): string {
  if (day === today) return "today";
  return formatDay(day, undefined, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

function AccountName({ summary }: { summary: AccountSummary }) {
  const { account } = summary;
  return (
    <div className="flex min-w-0 flex-col">
      <Link href={summary.href} className="ui-table-link -my-2.5 block truncate py-2.5">
        {account.name}
      </Link>
      <span className="t-caption truncate">{typeAndBroker(account.type, account.broker)}</span>
    </div>
  );
}

function PlatformCell({ summary, display }: { summary: AccountSummary; display: TimeDisplay }) {
  const { metrics } = summary;
  const connection = connectionLabel(summary.connection, display);
  return (
    <div className="flex flex-col">
      <span>{metrics.platform.label}</span>
      {metrics.platform.value !== "MANUAL" || connection !== "Manual" ? <span className="t-caption">{connection}</span> : <span className="t-caption">Recorded by you</span>}
    </div>
  );
}

function RecordedValues({ metrics, today, active }: { metrics: AccountMetrics; today: string; active: boolean }) {
  const balance = metrics.lastBalance;
  if (balance.value === null) return <UnknownValue reason={balance.unknownReason} />;
  const stale = active && balance.value.day !== today;
  const equity = metrics.lastEquity.value;
  return (
    <div className="flex flex-col items-end">
      <Money value={balance.value.amount} currency={metrics.currency} className="font-medium" />
      <span className="t-caption">
        {equity && <>Equity <Money value={equity.amount} currency={metrics.currency} /> · </>}
        <span className={stale ? "inline-flex items-center gap-1 text-warn" : undefined}>
          {stale && <TriangleAlert aria-hidden="true" className="size-3" />}
          recorded {recordedDay(balance.value.day, today)}
        </span>
      </span>
    </div>
  );
}

function TradesCell({ metrics }: { metrics: AccountMetrics }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="num">{metrics.closedCount} closed</span>
      {metrics.openCount > 0 && (
        <StatusPill tone="live" className="text-xs">
          {metrics.openCount} live
        </StatusPill>
      )}
    </div>
  );
}

function CumulativeR({ metrics }: { metrics: AccountMetrics }) {
  return (
    <div className="flex flex-col items-end">
      <KnownValue known={metrics.cumulativeR} render={value => <RValue value={value} />} />
      {metrics.excludedNoRiskBasis > 0 && <span className="t-caption">{metrics.excludedNoRiskBasis} without risk</span>}
    </div>
  );
}

function StatusCell({ summary }: { summary: AccountSummary }) {
  return summary.account.status === "ACTIVE" ? <StatusPill tone="neutral">Active</StatusPill> : <StatusPill tone="muted">Archived</StatusPill>;
}

interface TotalsProps {
  /** Per-currency money of currencies with two or more accounts (a single account's total repeats its row). */
  totals: CurrencyTotals[];
  combined: CombinedR;
}

function AccountsTable({ rows, caption, today, display, totals }: { rows: AccountSummary[]; caption: string; today: string; display: TimeDisplay; totals?: TotalsProps }) {
  return (
    <Table caption={caption} wrapperClassName="hidden md:block">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Platform</TableHeaderCell>
          <TableHeaderCell>Currency</TableHeaderCell>
          <TableHeaderCell align="end">Recorded balance</TableHeaderCell>
          <TableHeaderCell align="end">Today</TableHeaderCell>
          <TableHeaderCell align="end">This month</TableHeaderCell>
          <TableHeaderCell align="end">Cumulative R</TableHeaderCell>
          <TableHeaderCell align="end">Trades</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="end">
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(summary => (
          <TableRow key={summary.account.id} interactive>
            <TableCell className="max-w-56">
              <AccountName summary={summary} />
            </TableCell>
            <TableCell>
              <PlatformCell summary={summary} display={display} />
            </TableCell>
            <TableCell className="num">{summary.metrics.currency}</TableCell>
            <TableCell align="end">
              <RecordedValues metrics={summary.metrics} today={today} active={summary.account.status === "ACTIVE"} />
            </TableCell>
            <TableCell align="end">
              <SignedMoney value={summary.metrics.todayPnl} currency={summary.metrics.currency} />
            </TableCell>
            <TableCell align="end">
              <SignedMoney value={summary.metrics.monthPnl} currency={summary.metrics.currency} />
            </TableCell>
            <TableCell align="end">
              <CumulativeR metrics={summary.metrics} />
            </TableCell>
            <TableCell align="end">
              <TradesCell metrics={summary.metrics} />
            </TableCell>
            <TableCell>
              <StatusCell summary={summary} />
            </TableCell>
            <TableCell align="end" className="w-12">
              <AccountRowMenu accountId={summary.account.id} name={summary.account.name} status={summary.account.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      {totals && <TotalsFooter {...totals} />}
    </Table>
  );
}

function TotalsFooter({ totals, combined }: TotalsProps) {
  return (
    <tfoot className="bg-surface-sunken">
      {totals.map(total => (
        <TableRow key={total.currency}>
          <TableCell colSpan={3}>
            <span className="font-semibold">Total {total.currency}</span>
            <span className="t-caption"> · {plural(total.accounts, "account")}</span>
          </TableCell>
          <TableCell align="end">
            <span className="t-caption">Not added up</span>
          </TableCell>
          <TableCell align="end">
            <SignedMoney value={total.todayPnl} currency={total.currency} className="font-semibold" />
          </TableCell>
          <TableCell align="end">
            <SignedMoney value={total.monthPnl} currency={total.currency} className="font-semibold" />
          </TableCell>
          <TableCell colSpan={4} />
        </TableRow>
      ))}
      <TableRow>
        <TableCell colSpan={6}>
          <span className="font-semibold">All active accounts</span>
          <span className="t-caption"> · {R_UNITS_NOTE}</span>
        </TableCell>
        <TableCell align="end">
          <CombinedRValue combined={combined} />
        </TableCell>
        <TableCell colSpan={3} />
      </TableRow>
    </tfoot>
  );
}

interface CombinedR {
  netR: string | null;
  rTrades: number;
  excluded: number;
}

/** Cumulative R across accounts: valid because R is per-trade risk units (§9.3); trades without risk are left out. */
function combinedR(accounts: readonly AccountMetrics[]): CombinedR {
  const known = accounts.flatMap(metrics => (metrics.cumulativeR.value === null ? [] : [metrics.cumulativeR.value]));
  return {
    netR: known.length ? sumDecimals(known) : null,
    rTrades: accounts.reduce((total, metrics) => total + metrics.rTrades, 0),
    excluded: accounts.reduce((total, metrics) => total + metrics.excludedNoRiskBasis, 0),
  };
}

function CombinedRValue({ combined }: { combined: CombinedR }) {
  return (
    <div className="flex flex-col items-end">
      {combined.netR === null ? <UnknownValue reason="No closed trades with a recorded risk yet." /> : <RValue value={combined.netR} className="font-semibold" />}
      {combined.excluded > 0 && <span className="t-caption">{combined.excluded} without risk</span>}
    </div>
  );
}

/** Phone layout: one card per account with the numbers a trader checks first. */
function AccountCards({ rows, label, today, display }: { rows: AccountSummary[]; label: string; today: string; display: TimeDisplay }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
      {rows.map(summary => {
        const { account, metrics } = summary;
        return (
          <li key={account.id} className="card flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <Link href={summary.href} className="ui-table-link -my-2.5 block truncate py-2.5 text-base">
                  {account.name}
                </Link>
                <span className="t-caption">
                  {typeAndBroker(account.type, account.broker)} · {metrics.currency} · {connectionLabel(summary.connection, display)}
                </span>
              </div>
              <div className="flex flex-none items-center gap-1">
                {account.status === "ARCHIVED" && <StatusCell summary={summary} />}
                <AccountRowMenu accountId={account.id} name={account.name} status={account.status} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="col-span-2 flex items-baseline justify-between gap-3 border-b border-border pb-3">
                <dt className="t-meta">Recorded balance</dt>
                <dd className="text-right">
                  <RecordedValues metrics={metrics} today={today} active={account.status === "ACTIVE"} />
                </dd>
              </div>
              <div>
                <dt className="t-meta">Today</dt>
                <dd>
                  <SignedMoney value={metrics.todayPnl} currency={metrics.currency} className="font-medium" />
                </dd>
              </div>
              <div>
                <dt className="t-meta">This month</dt>
                <dd>
                  <SignedMoney value={metrics.monthPnl} currency={metrics.currency} className="font-medium" />
                </dd>
              </div>
              <div>
                <dt className="t-meta">Cumulative R</dt>
                <dd className="font-medium">
                  <KnownValue known={metrics.cumulativeR} render={value => <RValue value={value} />} />
                </dd>
              </div>
              <div>
                <dt className="t-meta">Trades</dt>
                <dd className="num">
                  {metrics.closedCount} closed
                  {metrics.openCount > 0 && <span className="text-live"> · {metrics.openCount} live</span>}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

/** Phone totals: the same per-currency money and combined R as the table footer. */
function TotalsCard({ totals, combined }: TotalsProps) {
  return (
    <section aria-label="Totals" className="card mt-3 flex flex-col gap-3 p-4 md:hidden">
      {totals.map(total => (
        <div key={total.currency} className="flex flex-col gap-1 border-b border-border pb-3">
          <p className="font-semibold text-text">
            Total {total.currency} <span className="t-caption font-normal">· {plural(total.accounts, "account")}</span>
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="t-meta">Today</dt>
              <dd>
                <SignedMoney value={total.todayPnl} currency={total.currency} className="font-medium" />
              </dd>
            </div>
            <div>
              <dt className="t-meta">This month</dt>
              <dd>
                <SignedMoney value={total.monthPnl} currency={total.currency} className="font-medium" />
              </dd>
            </div>
          </dl>
        </div>
      ))}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-text">All active accounts</p>
          <p className="t-caption">{R_UNITS_NOTE}</p>
        </div>
        <CombinedRValue combined={combined} />
      </div>
    </section>
  );
}

export function AccountsOverviewView({ overview, display }: AccountsOverviewViewProps) {
  const { active, archived, totals } = overview;
  const today = strategyDay(overview.now);
  const newAccount = (
    <Link href="/accounts/new" className={buttonClasses({ variant: "primary" })}>
      <Plus aria-hidden="true" />
      New account
    </Link>
  );
  const shared = totals.filter(total => total.accounts > 1);
  const footer: TotalsProps | null = active.length > 1 ? { totals: shared, combined: combinedR(active.map(summary => summary.metrics)) } : null;
  const summaryLine = [plural(active.length, "active account"), ...(archived.length ? [`${archived.length} archived`] : [])].join(" · ");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Accounts"
        description="Recorded values and closed-trade results of each trading account, in its own currency."
        actions={newAccount}
      />

      {active.length === 0 && archived.length === 0 ? (
        <EmptyState
          icon={<Wallet />}
          headingLevel={2}
          title="No trading accounts yet."
          description="Create your first trading account to plan and record trades. Each account keeps its own currency, risk plan and instruments."
          actions={newAccount}
        />
      ) : (
        <>
          <section aria-labelledby={ACTIVE_ACCOUNTS_HEADING} className="flex flex-col">
            <SectionHeader
              id={ACTIVE_ACCOUNTS_HEADING}
              title="Active accounts"
              description={`${summaryLine}. Totals add money only within one currency; balances are never added up.`}
            />
            {active.length ? (
              <>
                <AccountsTable rows={active} caption="Active trading accounts" today={today} display={display} totals={footer ?? undefined} />
                <AccountCards rows={active} label="Active trading accounts" today={today} display={display} />
                {footer && <TotalsCard {...footer} />}
              </>
            ) : (
              <EmptyState compact icon={<Layers />} title="No active trading accounts." description="Restore an archived account or create a new one to plan and record trades." actions={newAccount} />
            )}
          </section>

          {archived.length > 0 && (
            <Disclosure summary={`Archived accounts · ${archived.length}`} bodyClassName="flex flex-col gap-3 pt-1">
              <p className="t-meta">Archived accounts take no new trades. Their history stays readable on their dashboards.</p>
              <AccountsTable rows={archived} caption="Archived trading accounts" today={today} display={display} />
              <AccountCards rows={archived} label="Archived trading accounts" today={today} display={display} />
            </Disclosure>
          )}

          <p className="t-caption">
            Recorded balance and equity are what you entered; they are never estimated or added up across accounts. Today and This month are net P&L of trades
            closed in Trading OS on UTC−5 strategy days. {R_UNITS_NOTE}
          </p>
        </>
      )}
    </div>
  );
}
