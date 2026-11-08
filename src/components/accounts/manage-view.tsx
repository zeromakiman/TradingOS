import { ChevronLeft, CircleCheck, PlusCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ACCOUNT_TYPE_LABELS, type AccountPlatform, type AccountType, PLATFORM_LABELS } from "@/domain/account-metrics";
import { formatDecimal, formatMoney, formatMoneyExact, formatPercent, formatPrice, formatQuantity, formatSignedMoney, plural } from "@/domain/format";
import { formatDateTime, formatDay, formatTime, type TimeDisplay } from "@/domain/time-display";
import { Badge, StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { prefetchFor } from "@/components/ui/links";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Stat } from "@/components/ui/stat";
import { DataTable } from "@/components/ui/table";
import { TabLinks } from "@/components/ui/tab-links";
import type { AccountManage, ExternalLossView, InstrumentVersionView, RiskPlanVersionView } from "@/lib/accounts-data";
import type { WorkspaceObservation } from "@/lib/workspace";
import { type ExternalExecution, READ_ONLY_SCOPE } from "@/lib/sync-service";
import { AccountStatusButton } from "./account-status-actions";
import { ConfirmUnchangedButton, UpdateValuesForm } from "./account-values-forms";
import { connectionLabel } from "./accounts-overview";
import type { ConnectionDetails } from "./connection-data";
import {
  ADD_EXTERNAL_LOSS, ARCHIVE_COPY, ARCHIVED_VALUES_COPY, accountDashboardHref, EXTERNAL_LOSSES_TITLE, MANAGE_TABS, MANUAL_CONNECTION_COPY, type ManageTab, manageHref,
  RESTORE_COPY, RR_POLICY_LABELS, STARTS_TOMORROW, typeAndBroker, UPDATE_VALUES, VERSIONING_COPY,
} from "./copy";
import { LinkExecutionForm, MockConnectButton, MockSyncControls, UnlinkExecutionButton } from "./manage-connection-controls";
import { AddExternalLossForm, ExternalLossHelp, RemoveExternalLossButton } from "./manage-external-losses";
import { type InstrumentDraft, InstrumentForm } from "./manage-instrument-form";
import { ProfileForm } from "./manage-profile-form";
import { type RiskPolicyDefaults, RiskPolicyForm } from "./manage-risk-policy-form";
import { RiskPlanStatusPill, RiskPlanTable } from "./risk-plan-table";
import { Money } from "./values";

/**
 * Manage a trading account (docs/V2_ARCHITECTURE.md §14.9): Profile, Account values, External losses, Risk policy,
 * Instruments and Connection, one tab per URL (`?tab=`). Every change appends a record; nothing is edited in place.
 */

export interface ManageViewProps {
  manage: AccountManage;
  display: TimeDisplay;
  tab: ManageTab;
  /** Connection tab only. */
  connection: ConnectionDetails | null;
  /** Prefill of the instrument form (`?symbol=` of an existing instrument). */
  instrumentDraft: InstrumentDraft | null;
}

function ManageHeader({ manage }: { manage: AccountManage }) {
  const { account } = manage;
  const dashboard = accountDashboardHref(account);
  return (
    <PageHeader
      className="mb-0"
      eyebrow={
        <Link href={dashboard} prefetch={prefetchFor(dashboard, undefined)} className="inline-flex min-h-10 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
          <ChevronLeft aria-hidden="true" className="size-4" />
          {account.name}
        </Link>
      }
      title={`Manage ${account.name}`}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{[typeAndBroker(account.type, account.broker), PLATFORM_LABELS[account.platform], account.currency].join(" · ")}</span>
          {manage.archived && <StatusPill tone="muted">Archived</StatusPill>}
        </span>
      }
    />
  );
}

function ManageTabs({ accountId, tab }: { accountId: string; tab: ManageTab }) {
  return (
    <>
      <TabLinks
        label="Account settings"
        className="hidden md:flex"
        items={MANAGE_TABS.map(item => ({ href: manageHref(accountId, item.key), label: item.label, current: item.key === tab }))}
      />
      <nav aria-label="Account settings" className="grid grid-cols-2 gap-1.5 md:hidden">
        {MANAGE_TABS.map(item => (
          <Link
            key={item.key}
            href={manageHref(accountId, item.key)}
            aria-current={item.key === tab ? "page" : undefined}
            className={cx(
              "flex min-h-11 items-center justify-center rounded-control border px-2 text-center text-sm font-medium no-underline",
              item.key === tab ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-text-2",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

function PanelCard({ id, title, description, actions, children, className }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card as="section" aria-labelledby={id} className={className}>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle id={id}>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Profile.
// ---------------------------------------------------------------------------------------------------------
function ProfilePanel({ manage, display }: ManageViewProps) {
  const { account } = manage;
  const status = account.status;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <PanelCard id="profile-heading" title="Profile" description="Each save keeps the earlier version in the history.">
          <ProfileForm
            accountId={account.id}
            currency={account.currency}
            name={account.name}
            broker={account.broker}
            platform={account.platform}
            type={account.type}
            startingBalance={manage.startingBalance}
          />
        </PanelCard>
        <PanelCard id="status-heading" title={status === "ACTIVE" ? "Archive" : "Archived"}>
          <div className="flex flex-col gap-4">
            <p className="t-meta">{status === "ACTIVE" ? ARCHIVE_COPY : RESTORE_COPY}</p>
            <div>
              <AccountStatusButton accountId={account.id} name={account.name} status={status} />
            </div>
          </div>
        </PanelCard>
      </div>
      {manage.profileHistory.length > 0 && (
        <Disclosure summary={`Profile history · ${plural(manage.profileHistory.length, "version")}`} bodyClassName="pt-1">
          <DataTable
            caption="Profile history"
            cards
            rows={manage.profileHistory}
            rowKey={row => row.recordedAt}
            columns={[
              { key: "saved", header: "Saved", cell: row => <span className="num whitespace-nowrap">{formatDateTime(row.recordedAt, display, { year: true })}</span> },
              { key: "name", header: "Name", cell: row => row.name },
              { key: "type", header: "Type", cell: row => ACCOUNT_TYPE_LABELS[row.type as AccountType] ?? "Other" },
              { key: "broker", header: "Broker", cell: row => row.broker ?? "—" },
              { key: "platform", header: "Platform", cell: row => PLATFORM_LABELS[row.platform as AccountPlatform] ?? "Other" },
              { key: "start", header: "Starting balance", align: "end", cell: row => (row.startingBalance === null ? "—" : formatMoney(row.startingBalance, account.currency)) },
              { key: "status", header: "Status", cell: row => (row.status === "ACTIVE" ? "Active" : "Archived") },
              { key: "source", header: "Saved by", cell: row => (row.source === "USER" ? "You" : "Set up from earlier data") },
            ]}
          />
        </Disclosure>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Account values.
// ---------------------------------------------------------------------------------------------------------
/** Today's confirmation state; archived accounts plan nothing, so they are never asked to confirm. */
function ValuesFreshness({ manage, latestId }: { manage: AccountManage; latestId: string }) {
  if (manage.archived) return null;
  if (manage.values.confirmedToday) return <Callout tone="positive" title="Balance confirmed today." />;
  return (
    <Callout
      tone="warning"
      title="Confirm today's balance."
      action={<ConfirmUnchangedButton accountId={manage.account.id} observationId={latestId} focusAfter={VALUES_HEADING} />}
    >
      Plans can't be locked until today's values are recorded. If nothing changed, confirm the values above in one click.
    </Callout>
  );
}

const VALUES_HEADING = "values-heading";

function ValuesPanel({ manage, display }: ManageViewProps) {
  const { account, values } = manage;
  const latest = values.latest;
  const legacy = values.history.some(row => row.grossLossToday !== null);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <PanelCard id={VALUES_HEADING} title="Latest recorded values" description="What you reported; Trading OS never estimates balance or equity.">
          {latest ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 [&_.stat-value]:text-xl md:[&_.stat-value]:text-2xl">
                <Stat label="Balance" value={formatMoney(latest.balance, account.currency)} />
                <Stat label="Equity" value={formatMoney(latest.equity, account.currency)} />
              </div>
              <p className="t-meta">
                For {formatDay(latest.tradingDay, undefined, { weekday: true })} (UTC−5) · saved {formatDateTime(latest.recordedAt, display)}
              </p>
              <ValuesFreshness manage={manage} latestId={latest.id} />
            </div>
          ) : (
            <EmptyState
              compact
              title="No account values yet."
              description={manage.archived ? undefined : "Record the balance and equity your broker shows; plans can be locked once today's values exist."}
            />
          )}
        </PanelCard>
        <PanelCard id="update-values-heading" title={UPDATE_VALUES} description={manage.archived ? undefined : "Record new values when your balance or equity changed."}>
          {manage.archived ? (
            <p className="t-meta">{ARCHIVED_VALUES_COPY}</p>
          ) : (
            <UpdateValuesForm accountId={account.id} currency={account.currency} balance={latest?.balance ?? null} equity={latest?.equity ?? null} />
          )}
        </PanelCard>
      </div>
      <section aria-labelledby="values-history" className="flex flex-col gap-3">
        <SectionHeader id="values-history" title="History" description="Newest first. Each record keeps the trading day it was entered for." className="mb-0" />
        <ValuesTable rows={values.history.slice(0, RECENT_VALUES)} currency={account.currency} display={display} caption="Recent account values" legacy={legacy} />
        {values.history.length > RECENT_VALUES && (
          <Disclosure summary={`Older records · ${values.history.length - RECENT_VALUES}`} bodyClassName="pt-1">
            <ValuesTable rows={values.history.slice(RECENT_VALUES)} currency={account.currency} display={display} caption="Older account values" legacy={legacy} />
          </Disclosure>
        )}
      </section>
    </div>
  );
}

const RECENT_VALUES = 7;

function ValuesTable(props: { rows: WorkspaceObservation[]; currency: string; display: TimeDisplay; caption: string; legacy: boolean }) {
  const { rows, currency, caption, display } = props;
  return (
    <>
      <ValuesDataTable {...props} />
      <ul className="card flex flex-col px-4 md:hidden" aria-label={caption}>
        {rows.map(row => (
          <li key={row.id} className="flex items-baseline justify-between gap-3 border-b border-border py-3 last:border-b-0">
            <span className="flex flex-col text-sm text-text-2">
              {formatDay(row.tradingDay, undefined, { weekday: true })}
              <span className="t-caption">saved {formatTime(row.recordedAt, display)}</span>
            </span>
            <span className="flex flex-col items-end text-sm">
              <span>
                Balance <Money value={row.balance} currency={currency} className="font-medium" />
              </span>
              <span className="t-caption">
                Equity <Money value={row.equity} currency={currency} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ValuesDataTable({ rows, currency, display, caption, legacy }: { rows: WorkspaceObservation[]; currency: string; display: TimeDisplay; caption: string; legacy: boolean }) {
  const account = { currency };
  return (
        <DataTable
          caption={caption}
          className="hidden md:block"
          rows={rows}
          rowKey={row => row.id}
          empty={<p className="t-meta">No values recorded yet.</p>}
          columns={[
            { key: "day", header: "Trading day", cell: row => <span className="whitespace-nowrap">{formatDay(row.tradingDay, undefined, { weekday: true, year: true })}</span> },
            { key: "balance", header: "Balance", align: "end", cell: row => <Money value={row.balance} currency={account.currency} /> },
            { key: "equity", header: "Equity", align: "end", cell: row => <Money value={row.equity} currency={account.currency} /> },
            { key: "saved", header: "Saved", cell: row => <span className="num whitespace-nowrap">{formatDateTime(row.recordedAt, display)}</span> },
            ...(legacy
              ? [
                  {
                    key: "legacy",
                    header: "Losses entered (earlier version)",
                    align: "end" as const,
                    cell: (row: WorkspaceObservation) =>
                      row.grossLossToday === null ? <span className="text-text-3">—</span> : <Money value={row.grossLossToday} currency={account.currency} />,
                  },
                ]
              : []),
          ]}
        />
  );
}

// ---------------------------------------------------------------------------------------------------------
// External losses.
// ---------------------------------------------------------------------------------------------------------
function LossItem({ loss, currency, display, removable }: { loss: ExternalLossView; currency: string; display: TimeDisplay; removable: boolean }) {
  const removed = loss.removedAt !== null;
  const amount = formatMoney(loss.amount, currency);
  return (
    <li className="flex items-start justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={cx("num font-medium", removed && "text-text-3 line-through")}>{amount}</p>
        {loss.note && <p className="text-sm text-text-2">{loss.note}</p>}
        <p className="t-caption">
          Added {formatDateTime(loss.recordedAt, display)}
          {removed && loss.removedAt && ` · removed ${formatDateTime(loss.removedAt, display)}${loss.removalReason ? `: ${loss.removalReason}` : ""}`}
        </p>
      </div>
      {removed ? <StatusPill tone="muted">Removed</StatusPill> : removable && <RemoveExternalLossButton entryId={loss.id} amountLabel={amount} />}
    </li>
  );
}

function ExternalLossesPanel({ manage, display }: ManageViewProps) {
  const { account, externalLosses } = manage;
  // Entries that still count first, then removed ones; each group newest first.
  const today = [...externalLosses.today].sort((x, y) => Number(x.removedAt !== null) - Number(y.removedAt !== null));
  const earlier = externalLosses.recent.filter(loss => loss.tradingDay !== manage.day);
  const activeCount = today.filter(loss => loss.removedAt === null).length;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <PanelCard
          id="external-today"
          title={EXTERNAL_LOSSES_TITLE}
          description={`${formatDay(manage.day, undefined, { weekday: true })} (UTC−5). Counted in today's daily loss total with the losses of trades closed in Trading OS.`}
        >
          <div className="flex flex-col gap-2">
            <Stat label="Total today" value={formatMoney(externalLosses.todayTotal, account.currency)} hint={activeCount ? plural(activeCount, "entry", "entries") : undefined} />
            {today.length ? (
              <ul aria-label="External losses today">
                {today.map(loss => (
                  <LossItem key={loss.id} loss={loss} currency={account.currency} display={display} removable />
                ))}
              </ul>
            ) : (
              <p className="t-meta">No external losses today.</p>
            )}
          </div>
        </PanelCard>
        <PanelCard id="external-add" title={ADD_EXTERNAL_LOSS}>
          <div className="flex flex-col gap-4">
            <ExternalLossHelp />
            {account.status === "ACTIVE" ? (
              <AddExternalLossForm accountId={account.id} currency={account.currency} />
            ) : (
              <p className="t-meta">Archived accounts take no new records. Restore the account to add a loss.</p>
            )}
          </div>
        </PanelCard>
      </div>
      <section aria-labelledby="external-history" className="flex flex-col">
        <SectionHeader id="external-history" title="Earlier days" description="Earlier entries only count on their own trading day." />
        <DataTable
          caption="Earlier external losses"
          cards
          rows={earlier}
          rowKey={row => row.id}
          empty={<p className="t-meta">No external losses on earlier days.</p>}
          columns={[
            { key: "day", header: "Trading day", cell: row => <span className="whitespace-nowrap">{formatDay(row.tradingDay, undefined, { weekday: true, year: true })}</span> },
            {
              key: "amount",
              header: "Amount",
              align: "end",
              cell: row => <span className={cx("num", row.removedAt && "text-text-3 line-through")}>{formatMoney(row.amount, account.currency)}</span>,
            },
            { key: "note", header: "Note", cell: row => row.note ?? <span className="text-text-3">—</span> },
            {
              key: "status",
              header: "Status",
              cell: row => (row.removedAt ? <span className="t-meta">Removed{row.removalReason ? `: ${row.removalReason}` : ""}</span> : "Counted"),
            },
          ]}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Risk policy.
// ---------------------------------------------------------------------------------------------------------
function policyDefaults(plan: RiskPlanVersionView): RiskPolicyDefaults {
  return {
    maxRiskPercent: plan.maxRiskPercent, defaultRiskPercent: plan.defaultRiskPercent ?? plan.maxRiskPercent, maxDailyTrades: plan.maxDailyTrades,
    minRR: plan.minRR, rrPolicy: plan.rrPolicy, newsPolicy: plan.newsPolicy, dailyRiskCap: plan.dailyRiskCap, dailyLossCap: plan.dailyLossCap,
  };
}

const RISK_PLAN_V1_DEFAULTS: RiskPolicyDefaults = {
  maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null,
};

function PlanStats({ plan, currency, strategyMinimum }: { plan: RiskPlanVersionView; currency: string; strategyMinimum: { version: string; minimumRR: string } | null }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4 md:gap-x-6 [&_.stat-value]:text-xl md:[&_.stat-value]:text-2xl">
      <Stat label="Default risk" value={formatPercent(plan.defaultRiskPercent ?? plan.maxRiskPercent)} hint={plan.defaultRiskPercent === null ? "Same as the maximum" : "Preselected on new plans"} />
      <Stat label="Maximum risk" value={formatPercent(plan.maxRiskPercent)} hint="Plans above it are blocked" />
      <Stat label="Minimum RR" value={`${formatDecimal(plan.minRR)}R`} hint={RR_POLICY_LABELS[plan.rrPolicy]} />
      <Stat
        label="Strategy minimum"
        value={strategyMinimum ? `${formatDecimal(strategyMinimum.minimumRR)}R` : "—"}
        hint={strategyMinimum ? `Documented in ${strategyMinimum.version}` : "No documented minimum"}
      />
      <Stat label="Trades per day" value={plan.maxDailyTrades} hint="Planned and live-first" />
      <Stat label="Daily risk cap" value={plan.dailyRiskCap === null ? "None" : formatMoneyExact(plan.dailyRiskCap, currency)} hint="Risk reserved by the day's trades" />
      <Stat label="Daily loss limit" value={plan.dailyLossCap === null ? "None" : formatMoneyExact(plan.dailyLossCap, currency)} hint="Losses plus open risk" />
      <Stat label="Restricted news" value={plan.newsPolicy === "BLOCK" ? "Blocks" : "Warns"} hint="In a restricted news window" />
    </div>
  );
}

function RiskPolicyPanel({ manage, display }: ManageViewProps) {
  const { account, activeRiskPlan, strategy } = manage;
  const scheduled = manage.riskPlans.filter(plan => plan.status === "SCHEDULED");
  const base = manage.riskPlans.find(plan => plan.status === "SCHEDULED" || plan.status === "ACTIVE") ?? null;
  return (
    <div className="flex flex-col gap-6">
      <PanelCard
        id="current-plan"
        title={activeRiskPlan ? `Current: ${activeRiskPlan.version}` : "No active risk plan"}
        description={activeRiskPlan ? `In effect since ${formatDay(activeRiskPlan.effectiveDay, undefined, { weekday: true, year: true })}.` : "Create a version below; plans can be checked once one is active."}
        actions={activeRiskPlan ? <RiskPlanStatusPill plan={activeRiskPlan} /> : undefined}
      >
        <div className="flex flex-col gap-4">
          {activeRiskPlan && (
            <PlanStats
              plan={activeRiskPlan}
              currency={account.currency}
              strategyMinimum={strategy?.minimumRR ? { version: strategy.version, minimumRR: strategy.minimumRR } : null}
            />
          )}
          {activeRiskPlan?.overrideReason && <p className="t-meta">Applied immediately: {activeRiskPlan.overrideReason}</p>}
          {strategy?.warning && (
            <Callout tone="warning" title="Risk plan minimum is below the strategy's.">
              {strategy.warning} Trades between the two minimums pass the risk check but break the written strategy.
            </Callout>
          )}
        </div>
      </PanelCard>

      {scheduled.map(plan => (
        <Callout key={plan.id} tone="info" title={`${plan.version} · ${plan.statusLabel}`}>
          <span className="flex flex-col gap-1">
            <span>
              {plan.defaultRiskPercent ? `${formatPercent(plan.defaultRiskPercent)} default · ` : ""}
              {formatPercent(plan.maxRiskPercent)} maximum · {plural(plan.maxDailyTrades, "trade")} per day · minimum {formatDecimal(plan.minRR)}R
              {plan.dailyRiskCap ? ` · daily risk cap ${formatMoneyExact(plan.dailyRiskCap, account.currency)}` : ""}
              {plan.dailyLossCap ? ` · daily loss limit ${formatMoneyExact(plan.dailyLossCap, account.currency)}` : ""}
            </span>
            <span className="t-caption">
              {plan.statusLabel === STARTS_TOMORROW ? "Takes over at 00:00 UTC−5." : `Takes over on ${formatDay(plan.effectiveDay)} at 00:00 UTC−5.`} Until then {activeRiskPlan?.version ?? "the current version"} applies.
            </span>
          </span>
        </Callout>
      ))}

      <PanelCard id="new-version" title="Create a new version" description={VERSIONING_COPY}>
        <div className="flex flex-col gap-4">
          {base && <p className="t-meta">Prefilled from {base.version}{base.status === "SCHEDULED" ? ` (${base.statusLabel.toLowerCase()})` : ""}.</p>}
          <RiskPolicyForm accountId={account.id} currency={account.currency} defaults={base ? policyDefaults(base) : RISK_PLAN_V1_DEFAULTS} strategyMinimum={strategy?.minimumRR ?? null} />
        </div>
      </PanelCard>

      <section aria-labelledby="plan-versions" className="flex flex-col">
        <SectionHeader id="plan-versions" title="All versions" description="Newest first. Trades and checks keep the version they were evaluated with." />
        <RiskPlanTable plans={manage.riskPlans} currency={account.currency} display={display} detailed />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Instruments.
// ---------------------------------------------------------------------------------------------------------
function newVersionHref(accountId: string, symbol: string): string {
  return `${manageHref(accountId, "instruments")}&symbol=${encodeURIComponent(symbol)}#add-instrument`;
}

function InstrumentTable(props: { rows: InstrumentVersionView[]; currency: string; display: TimeDisplay; accountId: string; caption: string; withActions: boolean }) {
  return (
    <>
      <InstrumentDataTable {...props} />
      <InstrumentCards {...props} />
    </>
  );
}

/** Phones: one compact card per instrument version instead of a nine-row table card. */
function InstrumentCards({ rows, currency, display, accountId, caption, withActions }: { rows: InstrumentVersionView[]; currency: string; display: TimeDisplay; accountId: string; caption: string; withActions: boolean }) {
  return (
    <ul className="flex flex-col gap-2 md:hidden" aria-label={caption}>
      {rows.map(row => (
        <li key={row.id} className="card flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-text">{row.symbol}</p>
              <p className="t-caption">{row.quantityUnit}</p>
            </div>
            {withActions && (
              <Link href={newVersionHref(accountId, row.symbol)} className="-my-2 inline-flex min-h-11 flex-none items-center text-sm font-medium text-accent">
                New version
              </Link>
            )}
          </div>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
            <div>
              <dt className="t-caption">Tick size</dt>
              <dd className="num">{formatPrice(row.tickSize)}</dd>
            </div>
            <div>
              <dt className="t-caption">Tick value</dt>
              <dd className="num">
                {formatDecimal(row.tickValue)} {currency}
              </dd>
            </div>
            <div>
              <dt className="t-caption">Pip size</dt>
              <dd className="num">{row.pipSize === null ? "—" : formatPrice(row.pipSize)}</dd>
            </div>
            <div>
              <dt className="t-caption">Size step</dt>
              <dd className="num">{formatQuantity(row.quantityStep)}</dd>
            </div>
            <div>
              <dt className="t-caption">Minimum</dt>
              <dd className="num">{formatQuantity(row.minimumQuantity, row.quantityStep)}</dd>
            </div>
            <div>
              <dt className="t-caption">Added</dt>
              <dd className="num">{formatDay(row.createdAt, display, { year: true })}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function InstrumentDataTable({ rows, currency, display, accountId, caption, withActions }: { rows: InstrumentVersionView[]; currency: string; display: TimeDisplay; accountId: string; caption: string; withActions: boolean }) {
  return (
    <DataTable
      caption={caption}
      className="hidden md:block"
      rows={rows}
      rowKey={row => row.id}
      columns={[
        { key: "symbol", header: "Symbol", cell: row => <span className="font-medium">{row.symbol}</span> },
        { key: "unit", header: "Size unit", cell: row => row.quantityUnit },
        { key: "tick", header: "Tick size", align: "end", cell: row => <span className="num">{formatPrice(row.tickSize)}</span> },
        { key: "pip", header: "Pip size", align: "end", cell: row => <span className="num">{row.pipSize === null ? "—" : formatPrice(row.pipSize)}</span> },
        { key: "value", header: `Tick value (${currency})`, align: "end", cell: row => <span className="num">{formatDecimal(row.tickValue)}</span> },
        { key: "step", header: "Size step", align: "end", cell: row => <span className="num">{formatQuantity(row.quantityStep)}</span> },
        { key: "minimum", header: "Minimum size", align: "end", cell: row => <span className="num">{formatQuantity(row.minimumQuantity, row.quantityStep)}</span> },
        { key: "added", header: "Added", cell: row => <span className="num whitespace-nowrap">{formatDay(row.createdAt, display, { year: true })}</span> },
        ...(withActions
          ? [
              {
                key: "actions",
                header: "Actions",
                align: "end" as const,
                cell: (row: InstrumentVersionView) => (
                  <Link href={newVersionHref(accountId, row.symbol)} className="ui-table-link inline-flex min-h-10 items-center whitespace-nowrap pointer-coarse:min-h-11">
                    New version
                  </Link>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function InstrumentsPanel({ manage, display, instrumentDraft }: ManageViewProps) {
  const { account } = manage;
  const current = manage.instruments.filter(row => row.current).sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const older = manage.instruments.filter(row => !row.current);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="instruments-heading" className="flex flex-col">
        <SectionHeader
          id="instruments-heading"
          title="Instruments"
          description="The newest version of each symbol is offered in new plans. Trades keep the version they were planned with."
          actions={
            <Link href={`${manageHref(account.id, "instruments")}#add-instrument`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
              <PlusCircle aria-hidden="true" />
              Add instrument
            </Link>
          }
        />
        {current.length ? (
          <InstrumentTable rows={current} currency={account.currency} display={display} accountId={account.id} caption="Current instrument versions" withActions />
        ) : (
          <EmptyState
            compact
            title="No instruments yet."
            description={`Add the instruments you trade with their contract values in ${account.currency}; plans need at least one.`}
          />
        )}
      </section>
      {older.length > 0 && (
        <Disclosure summary={`Earlier versions · ${older.length}`} bodyClassName="flex flex-col gap-2 pt-1">
          <p className="t-meta">Replaced in new plans; trades written with them keep them.</p>
          <InstrumentTable rows={older} currency={account.currency} display={display} accountId={account.id} caption="Earlier instrument versions" withActions={false} />
        </Disclosure>
      )}
      <section id="add-instrument" aria-labelledby="add-instrument-heading" className="scroll-mt-20">
        <PanelCard
          id="add-instrument-heading"
          title={instrumentDraft ? `New version of ${instrumentDraft.symbol}` : "Add instrument"}
          description={
            instrumentDraft
              ? "Prefilled with the current version. Change what differs; the current version stays attached to earlier trades."
              : "Contract values from your broker's specification."
          }
          actions={
            instrumentDraft ? (
              <Link href={`${manageHref(account.id, "instruments")}#add-instrument`} className={buttonClasses({ variant: "ghost", size: "sm" })}>
                Start empty
              </Link>
            ) : undefined
          }
        >
          <InstrumentForm accountId={account.id} currency={account.currency} initial={instrumentDraft} />
        </PanelCard>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Connection.
// ---------------------------------------------------------------------------------------------------------
const DIRECTION = { LONG: "Long", SHORT: "Short" } as const;

function executionLabel(execution: ExternalExecution): string {
  return `${execution.symbol} ${DIRECTION[execution.direction]} · ${formatQuantity(execution.volume)}`;
}

function ExecutionFacts({ execution, display }: { execution: ExternalExecution; display: TimeDisplay }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="font-medium">{executionLabel(execution)}</p>
      <p className="t-caption">
        Entry {formatPrice(execution.entryPrice)} · {formatDateTime(execution.enteredAt, display)}
        {execution.exitPrice && execution.exitedAt && ` · exit ${formatPrice(execution.exitPrice)} · ${formatDateTime(execution.exitedAt, display)}`}
        {execution.realizedPnl && ` · ${formatSignedMoney(execution.realizedPnl, execution.currency)}`}
      </p>
      <p className="t-caption">From {execution.connectionLabel}</p>
    </div>
  );
}

function ConnectionPanel({ manage, display, connection }: ManageViewProps) {
  const { account } = manage;
  const state = manage.connection;
  const active = state.connection;
  const mock = manage.platformOptions.find(option => option.provider === "MOCK" && option.available);
  const planned = manage.platformOptions.filter(option => option.provider !== "MOCK");
  const unmatched = connection?.unmatched ?? [];
  const linked = connection?.linked ?? [];
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <PanelCard id="connection-heading" title="Connection" actions={<StatusPill tone={state.mode === "ERROR" ? "negative" : state.mode === "MANUAL" ? "neutral" : "info"}>{connectionLabel(state, display)}</StatusPill>}>
          {active ? (
            <div className="flex flex-col gap-3">
              <p>
                <span className="font-medium">{active.label}</span>
                {active.externalAccountRef && <span className="t-meta"> · account {active.externalAccountRef}</span>}
              </p>
              {state.message && (
                <Callout tone="negative" title="The last sync failed.">
                  {state.message}
                </Callout>
              )}
              {active.statusMessage && !state.message && <p className="t-meta">{active.statusMessage}</p>}
              <p className="t-caption">
                {plural(active.executionCount, "execution")} received · {active.unmatchedCount} waiting for you
                {active.warningCount > 0 && ` · ${plural(active.warningCount, "change")} not applied`}
              </p>
              {active.provider === "MOCK" && mock && <MockSyncControls connectionId={active.id} connectionLabel={active.label} />}
            </div>
          ) : (
            <p className="t-meta">{MANUAL_CONNECTION_COPY}</p>
          )}
        </PanelCard>
        <PanelCard id="platforms-heading" title="Platform sync" description="Automatic import isn't available yet. Until then every trade is recorded by you.">
          <ul className="flex flex-col">
            {planned.map(option => (
              <li key={option.provider} className="flex flex-col gap-1 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{option.name}</span>
                  <Badge>Planned</Badge>
                </p>
                <p className="t-meta">{option.note}</p>
                {option.provider === "CTRADER" && <p className="t-caption">{READ_ONLY_SCOPE}</p>}
              </li>
            ))}
            {mock && (
              <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{mock.name}</span>
                  <Badge tone="accent">Developer</Badge>
                </p>
                <p className="t-meta">{mock.note}</p>
                {!active && account.status === "ACTIVE" && <MockConnectButton accountId={account.id} />}
              </li>
            )}
          </ul>
        </PanelCard>
      </div>

      <PanelCard
        id="unmatched-heading"
        title="Unmatched executions"
        description="Platform positions that could not be matched to exactly one planned trade. Link each to the trade it belongs to."
      >
        {unmatched.length ? (
          <ul className="flex flex-col">
            {unmatched.map(({ execution, candidates }) => (
              <li key={execution.id} className="grid gap-3 border-b border-border py-4 first:pt-0 last:border-b-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <ExecutionFacts execution={execution} display={display} />
                <LinkExecutionForm
                  executionId={execution.id}
                  executionLabel={executionLabel(execution)}
                  options={candidates.map(candidate => ({
                    tradeId: candidate.tradeId,
                    suggested: candidate.suggested,
                    label: `${candidate.symbol ?? execution.symbol} ${candidate.direction ? DIRECTION[candidate.direction] : ""} · locked ${formatDateTime(candidate.lockedAt, display)}${candidate.plannedEntry ? ` · entry ${formatPrice(candidate.plannedEntry, candidate.tickSize)}` : ""}`,
                  }))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<CircleCheck />}
            title="No unmatched executions."
            description="When platform sync is available, executions that can't be matched automatically wait here for you."
          />
        )}
        {connection?.moreUnmatched && <p className="t-caption mt-3">More executions are waiting; link these first to see the rest.</p>}
      </PanelCard>

      {linked.length > 0 && (
        <PanelCard id="linked-heading" title="Linked executions" description="Platform positions linked to trades in this account.">
          <ul className="flex flex-col">
            {linked.map(execution => (
              <li key={execution.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0">
                <ExecutionFacts execution={execution} display={display} />
                <div className="flex items-center gap-2">
                  {execution.linkedTradeId && (
                    <Link href={`/trades/${execution.linkedTradeId}`} className={buttonClasses({ variant: "ghost", size: "sm" })}>
                      Open trade
                    </Link>
                  )}
                  {execution.linkedTradeId && execution.linkMethod !== "IMPORT_CREATED" ? (
                    <UnlinkExecutionButton tradeId={execution.linkedTradeId} executionId={execution.id} executionLabel={executionLabel(execution)} />
                  ) : (
                    <span className="t-caption">Imported trade</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {connection?.moreLinked && <p className="t-caption mt-3">Showing the {linked.length} most recent linked executions.</p>}
        </PanelCard>
      )}
    </div>
  );
}

const PANELS: Readonly<Record<ManageTab, (props: ManageViewProps) => ReactNode>> = {
  profile: ProfilePanel,
  "account-values": ValuesPanel,
  "external-losses": ExternalLossesPanel,
  "risk-policy": RiskPolicyPanel,
  instruments: InstrumentsPanel,
  connection: ConnectionPanel,
};

export function ManageView(props: ManageViewProps) {
  const { manage, tab } = props;
  const Panel = PANELS[tab];
  const label = MANAGE_TABS.find(item => item.key === tab)?.label ?? "Profile";
  return (
    <div className="flex flex-col gap-6">
      <ManageHeader manage={manage} />
      {manage.archived && (
        <Callout tone="neutral" title="This account is archived.">
          It takes no new trades. Restore it in Profile to plan or record trades again.
        </Callout>
      )}
      <ManageTabs accountId={manage.account.id} tab={tab} />
      <section aria-label={label}>
        <Panel {...props} />
      </section>
    </div>
  );
}
