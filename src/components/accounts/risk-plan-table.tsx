import { CalendarClock } from "lucide-react";
import { formatDecimal, formatMoneyExact, formatPercent } from "@/domain/format";
import { formatDateTime, formatDay, type TimeDisplay } from "@/domain/time-display";
import { StatusPill, type StatusTone } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/table";
import type { RiskPlanStatus, RiskPlanVersionView } from "@/lib/accounts-data";

/** Risk plan versions with their status on today's strategy day (spec §3.10, §14.8–14.9). */

const STATUS_TONE: Readonly<Record<RiskPlanStatus, StatusTone>> = Object.freeze({ ACTIVE: "info", SCHEDULED: "neutral", NEVER_EFFECTIVE: "muted", SUPERSEDED: "muted" });

export function RiskPlanStatusPill({ plan }: { plan: RiskPlanVersionView }) {
  return (
    <StatusPill tone={STATUS_TONE[plan.status]} icon={plan.status === "SCHEDULED" ? <CalendarClock aria-hidden="true" className="size-3.5" /> : undefined}>
      {plan.statusLabel}
    </StatusPill>
  );
}

/** `0.50% default · 0.75% maximum`; legacy versions without a default use the maximum. */
export function riskPerTrade(plan: Pick<RiskPlanVersionView, "defaultRiskPercent" | "maxRiskPercent">): string {
  return plan.defaultRiskPercent === null
    ? `${formatPercent(plan.maxRiskPercent)} (default = maximum)`
    : `${formatPercent(plan.defaultRiskPercent)} default · ${formatPercent(plan.maxRiskPercent)} maximum`;
}

export function minimumRr(plan: Pick<RiskPlanVersionView, "minRR" | "rrPolicy">): string {
  return `${formatDecimal(plan.minRR)}R · ${plan.rrPolicy === "BLOCK" ? "blocks" : "warns"}`;
}

function capParts(plan: Pick<RiskPlanVersionView, "dailyRiskCap" | "dailyLossCap">, currency: string): string[] {
  return [
    plan.dailyRiskCap === null ? null : `Risk ${formatMoneyExact(plan.dailyRiskCap, currency)}`,
    plan.dailyLossCap === null ? null : `Loss ${formatMoneyExact(plan.dailyLossCap, currency)}`,
  ].filter((part): part is string => part !== null);
}

/** `Risk $2,000.00 · Loss $4,000.00`, or `None`. */
export function dailyCaps(plan: Pick<RiskPlanVersionView, "dailyRiskCap" | "dailyLossCap">, currency: string): string {
  const parts = capParts(plan, currency);
  return parts.length ? parts.join(" · ") : "None";
}

export function RiskPlanTable(props: { plans: RiskPlanVersionView[]; currency: string; display?: TimeDisplay; detailed?: boolean }) {
  if (props.plans.length === 0) return <p className="t-meta">No risk plan versions yet.</p>;
  return (
    <>
      <RiskPlanDataTable {...props} />
      <RiskPlanCards {...props} />
    </>
  );
}

/** Phones: version, status and the policy in three short lines. */
function RiskPlanCards({ plans, currency, display, detailed = false }: { plans: RiskPlanVersionView[]; currency: string; display?: TimeDisplay; detailed?: boolean }) {
  return (
    <ul className="flex flex-col gap-2 md:hidden" aria-label="Risk plan versions">
      {plans.map(plan => (
        <li key={plan.id} className="card flex flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-text">{plan.version}</p>
              <p className="t-caption">
                From {formatDay(plan.effectiveDay, undefined, { year: true })}
                {detailed && display && ` · created ${formatDateTime(plan.createdAt, display)}`}
              </p>
            </div>
            <RiskPlanStatusPill plan={plan} />
          </div>
          <p className="text-sm">{riskPerTrade(plan)}</p>
          <p className="t-meta">
            {plan.maxDailyTrades} trades per day · minimum {minimumRr(plan)} · news {plan.newsPolicy === "BLOCK" ? "blocks" : "warns"}
          </p>
          <p className="t-meta">Daily caps: {dailyCaps(plan, currency)}</p>
          {plan.overrideReason && <p className="t-caption">Applied immediately: {plan.overrideReason}</p>}
        </li>
      ))}
    </ul>
  );
}

function RiskPlanDataTable({ plans, currency, display, detailed = false }: { plans: RiskPlanVersionView[]; currency: string; display?: TimeDisplay; detailed?: boolean }) {
  return (
    <DataTable
      caption="Risk plan versions"
      className="hidden md:block"
      rows={plans}
      rowKey={plan => plan.id}
      columns={[
        {
          key: "version",
          header: "Version",
          cell: plan => (
            <div className="flex flex-col">
              <span className="font-medium">{plan.version}</span>
              {detailed && display && <span className="t-caption">Created {formatDateTime(plan.createdAt, display)}</span>}
              {plan.overrideReason && <span className="t-caption">Applied immediately: {plan.overrideReason}</span>}
            </div>
          ),
        },
        { key: "status", header: "Status", cell: plan => <RiskPlanStatusPill plan={plan} /> },
        { key: "from", header: "From", cell: plan => <span className="num whitespace-nowrap">{formatDay(plan.effectiveDay, undefined, { year: true })}</span> },
        { key: "risk", header: "Risk per trade", cell: plan => <span className="md:whitespace-nowrap">{riskPerTrade(plan)}</span> },
        { key: "trades", header: "Trades / day", align: "end", cell: plan => <span className="num">{plan.maxDailyTrades}</span> },
        { key: "rr", header: "Minimum RR", cell: plan => <span className="whitespace-nowrap">{minimumRr(plan)}</span> },
        { key: "news", header: "Restricted news", cell: plan => (plan.newsPolicy === "BLOCK" ? "Blocks" : "Warns") },
        {
          key: "caps",
          header: "Daily caps",
          cell: plan => {
            const parts = capParts(plan, currency);
            return parts.length ? (
              <span className="flex flex-col whitespace-nowrap">
                {parts.map(part => (
                  <span key={part}>{part}</span>
                ))}
              </span>
            ) : (
              "None"
            );
          },
        },
      ]}
    />
  );
}
