import {
  Bot, Check, Code2, Database, Download, KeyRound, Link2, Monitor, OctagonAlert, PlugZap, ShieldCheck, SlidersHorizontal, Trash2,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { STRATEGY_ZONE_LABEL } from "@/domain/time-display";
import { AiBudgetSummary } from "../ai/ai-budget-summary";
import { StatusPill } from "../ui/badge";
import { buttonClasses } from "../ui/button";
import { Callout } from "../ui/callout";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { cx } from "../ui/cx";
import { Disclosure } from "../ui/disclosure";
import { EmptyState } from "../ui/empty-state";
import { PageHeader } from "../ui/page-header";
import { TechnicalDetails } from "../ui/technical-details";
import { AiAccountControls } from "./ai-account-controls";
import { ChangePasswordForm } from "./change-password-form";
import { DeleteAccount } from "./delete-account";
import { DeveloperModeSwitch, MockSyncControls } from "./developer-settings";
import { ExportData } from "./export-data";
import { GeneralSettings } from "./general-settings";
import type { SettingsAiAccount, SettingsPageData } from "./settings-data";
import { accountMeta, connectionView, DELETED_DATA, orderAccounts, type SettingsSectionId } from "./settings-model";
import { SettingsNav } from "./settings-nav";

/**
 * Settings (docs/V2_ARCHITECTURE.md §14.11): General, AI, Connections, Data, Security, Danger zone and Developer as
 * anchored sections of one page, with a section list beside them (desktop) or above them (phone). Presentational:
 * the route loads `SettingsPageData` (settings-data.ts) and passes it here.
 */

function Section({ id, title, description, icon, children }: { id: SettingsSectionId; title: string; description: ReactNode; icon: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-32 flex-col gap-4 lg:scroll-mt-24">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cx(
            "grid size-9 flex-none place-items-center rounded-[8px] border [&>svg]:size-[1.125rem]",
            id === "danger" ? "border-neg-border bg-neg-soft text-neg" : "border-border bg-surface text-2",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-lg font-semibold leading-7 text-text">
            {title}
          </h2>
          <p className="t-meta max-w-2xl">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function NoAccounts({ what, archived }: { what: string; archived: number }) {
  return (
    <Card>
      <EmptyState
        compact
        title={archived > 0 ? "No active trading accounts" : "No trading accounts yet"}
        description={archived > 0 ? `${what} Restore an archived account or create a new one.` : `${what} Create your first trading account to set it up.`}
        actions={
          <Link href="/accounts/new" className={buttonClasses({ variant: "secondary" })}>
            Create a trading account
          </Link>
        }
      />
    </Card>
  );
}

// ── AI ───────────────────────────────────────────────────────────────────────────────────

function enableBlockedReason(entry: SettingsAiAccount, deploymentReason: string | null): string | null {
  if (deploymentReason) return "AI can't be turned on while it is off for this deployment.";
  if (entry.budget.snapshot?.uncertain) return "Paused until the cost of an earlier request is reviewed. AI can't be turned on until then.";
  return null;
}

function AiAccountCard({ entry, data }: { entry: SettingsAiAccount; data: SettingsPageData }) {
  const { account, budget } = entry;
  return (
    <Card as="article" aria-label={`AI · ${account.name}`}>
      <AiBudgetSummary accountName={account.name} budget={budget} timeDisplay={data.preferences.timeDisplay} now={new Date(data.nowIso)} className="border-0 bg-transparent" />
      {budget.snapshot && (
        <div className="border-t border-border p-4 md:p-5">
          <AiAccountControls
            accountId={account.id}
            accountName={account.name}
            enabled={budget.snapshot.enabled}
            budgetCents={budget.snapshot.budgetCents}
            enableBlockedReason={enableBlockedReason(entry, data.ai.unavailableReason)}
          />
        </div>
      )}
    </Card>
  );
}

function AiSection({ data }: { data: SettingsPageData }) {
  const byId = new Map(data.ai.accounts.map(entry => [entry.account.id, entry]));
  const active = orderAccounts(data.active, data.selectedAccountId).flatMap(account => byId.get(account.id) ?? []);
  const archived = data.archived.flatMap(account => byId.get(account.id) ?? []);
  return (
    <Section
      id="ai"
      title="AI"
      icon={<Bot />}
      description="Advisory analysis you request explicitly, never automatic. It never decides whether you can trade: the Risk Engine does. Consent and monthly limits are set per trading account."
    >
      {data.ai.unavailableReason && <Callout tone="info" title="AI is off for this deployment">{data.ai.unavailableReason}</Callout>}
      {active.length === 0 ? (
        <NoAccounts what="AI consent and monthly limits belong to a trading account." archived={archived.length} />
      ) : (
        active.map(entry => <AiAccountCard key={entry.account.id} entry={entry} data={data} />)
      )}
      {active.length > 0 && (
        <p className="t-caption">
          Limits are in euros and reset on the 1st at 00:00 {STRATEGY_ZONE_LABEL}. Raising a limit never turns AI on; lowering it below this month's
          usage blocks further requests until the month resets.
        </p>
      )}
      {archived.length > 0 && (
        <Disclosure summary={`Archived accounts · ${archived.length}`}>
          <div className="flex flex-col gap-2">
            {archived.map(entry => (
              <AiBudgetSummary key={entry.account.id} accountName={entry.account.name} budget={entry.budget} compact now={new Date(data.nowIso)} />
            ))}
            <p className="t-meta">Archived accounts keep their AI history. Restore an account to change its AI settings.</p>
          </div>
        </Disclosure>
      )}
    </Section>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────────────────

function ConnectionsSection({ data }: { data: SettingsPageData }) {
  const rows = orderAccounts(data.connections.rows.map(row => ({ ...row, id: row.account.id })), data.selectedAccountId);
  return (
    <Section
      id="connections"
      title="Connections"
      icon={<PlugZap />}
      description="Trades are recorded manually in this version. Platform sync, when it arrives, is read-only: Trading OS never places, changes or closes a trade at your broker."
    >
      {data.connections.error && <Callout tone="warning" title="Connections unavailable">{data.connections.error}</Callout>}
      {data.active.length === 0 ? (
        <NoAccounts what="Each trading account has its own connection." archived={data.archived.length} />
      ) : rows.length > 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle as="h3">Trading accounts</CardTitle>
              <CardDescription>Where each account's trades come from.</CardDescription>
            </div>
          </CardHeader>
          <CardBody>
            <ul className="flex flex-col divide-y divide-border">
              {rows.map(({ account, snapshot }) => {
                const view = connectionView(snapshot, data.preferences.timeDisplay);
                return (
                  <li key={account.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold text-text">{account.name}</span>
                        <span className="t-caption">{accountMeta(account)}</span>
                      </p>
                      <div className="flex flex-none items-center gap-1">
                        <StatusPill tone={view.tone}>{view.label}</StatusPill>
                        <Link href={`/accounts/${account.id}/manage`} className={buttonClasses({ variant: "link", size: "sm", className: "min-h-10 px-2 pointer-coarse:min-h-11" })}>
                          Manage<span className="sr-only"> {account.name}</span>
                        </Link>
                      </div>
                    </div>
                    {(view.source || view.detail) && <p className="t-meta">{[view.source, view.detail].filter(Boolean).join(" · ")}</p>}
                    {view.attention.map(line => (
                      <p key={line} className="t-meta text-warn">
                        {line}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h3">Platforms</CardTitle>
            <CardDescription>What Trading OS can connect to today, and what is planned.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <ul className="flex flex-col divide-y divide-border">
            <li className="flex flex-col items-start gap-1 py-3 first:pt-0 sm:flex-row sm:justify-between sm:gap-6">
              <div>
                <p className="font-semibold text-text">Manual</p>
                <p className="t-meta">You record plans, entries and exits in Trading OS. Available for every trading account.</p>
              </div>
              <StatusPill tone="positive" icon={<Check aria-hidden="true" className="size-3" />}>
                In use
              </StatusPill>
            </li>
            {data.platforms.map(platform => (
              <li key={platform.provider} className="flex flex-col items-start gap-1 py-3 last:pb-0 sm:flex-row sm:justify-between sm:gap-6">
                <div>
                  <p className="font-semibold text-text">{platform.name}</p>
                  <p className="t-meta">{platform.note}.</p>
                  {platform.provider === "CTRADER" && (
                    <p className="t-caption mt-1">Read-only: account, positions, deals, balances. Trading OS never requests trading permission.</p>
                  )}
                </div>
                <StatusPill tone="muted">{platform.available ? "Available" : "Planned"}</StatusPill>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </Section>
  );
}

// ── Data, security, danger zone, developer ───────────────────────────────────────────────

const EXPORT_CONTENTS: readonly string[] = [
  "Trading accounts, risk plans, instruments, account values and external losses",
  "Every trade with its drafts, risk checks, plan, fills, result, journal, tags and reviews",
  "AI requests, results and usage records",
  "A trades spreadsheet (CSV) and a record of every screenshot",
];

function DataSection({ data }: { data: SettingsPageData }) {
  return (
    <Section
      id="data"
      title="Your data"
      icon={<Database />}
      description="Download everything Trading OS stores for you as one ZIP archive. It is assembled in this browser from your own records; exporting changes nothing."
    >
      <Card>
        <CardBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <p className="font-semibold text-text">Included</p>
            <ul className="flex flex-col gap-1.5">
              {EXPORT_CONTENTS.map(item => (
                <li key={item} className="flex items-start gap-2 text-2">
                  <Check aria-hidden="true" className="mt-1 size-3.5 flex-none text-pos" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <ExportData tables={data.export.tables} screenshots={data.export.screenshots} />
        </CardBody>
      </Card>
    </Section>
  );
}

function SecuritySection({ data }: { data: SettingsPageData }) {
  return (
    <Section id="security" title="Security" icon={<ShieldCheck />} description={<>Signed in as <span className="font-medium text-text">{data.user.email}</span>.</>}>
      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h3" className="flex items-center gap-2">
              <KeyRound aria-hidden="true" className="size-4 text-3" />
              Change password
            </CardTitle>
            <CardDescription>Enter your current password first. Your other devices are signed out after the change.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <ChangePasswordForm email={data.user.email} />
        </CardBody>
      </Card>
    </Section>
  );
}

function DangerSection({ data }: { data: SettingsPageData }) {
  return (
    <Section id="danger" title="Danger zone" icon={<OctagonAlert />} description="Irreversible actions. Read carefully before you continue.">
      <Card className="border-neg-border">
        <CardHeader>
          <div>
            <CardTitle as="h3" className="flex items-center gap-2">
              <Trash2 aria-hidden="true" className="size-4 text-neg" />
              Delete Trading OS account
            </CardTitle>
            <CardDescription>Permanently deletes your login and everything recorded with it:</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {DELETED_DATA.map(item => (
              <li key={item} className="flex items-start gap-2 text-2">
                <span aria-hidden="true" className="mt-2 size-1.5 flex-none rounded-pill bg-neg" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="text-2">
            <strong className="font-semibold text-text">This can't be undone.</strong> Nothing is kept for recovery: only an anonymous count of the
            deleted records remains, with no email or identity. Nothing at your broker or prop firm is affected.
          </p>
          <p className="text-2">
            Want a copy first?{" "}
            <a href="#data" className="inline-flex items-center gap-1 font-medium text-accent underline underline-offset-2">
              <Download aria-hidden="true" className="size-3.5" />
              Download my data
            </a>
          </p>
          <div>
            <DeleteAccount email={data.user.email} />
          </div>
        </CardBody>
      </Card>
    </Section>
  );
}

function DeveloperSection({ data }: { data: SettingsPageData }) {
  const mock = data.mockSync;
  return (
    <Section id="developer" title="Developer" icon={<Code2 />} description="Tools for inspecting records. Nothing here is needed for planning, recording or reviewing trades.">
      <Card>
        <CardBody>
          <DeveloperModeSwitch enabled={data.preferences.developerMode} />
        </CardBody>
      </Card>
      {mock && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle as="h3" className="flex items-center gap-2">
                <Link2 aria-hidden="true" className="size-4 text-3" />
                Mock platform sync
              </CardTitle>
              <CardDescription>Enabled for this deployment. A developer simulation with sample positions; it never contacts a real platform.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {mock.error && <Callout tone="warning">{mock.error}</Callout>}
            {mock.rows.length === 0 && !mock.error ? (
              <p className="t-meta">Create a trading account to try the mock platform.</p>
            ) : (
              <MockSyncControls
                rows={mock.rows.map(row => {
                  const view = connectionView(row.snapshot, data.preferences.timeDisplay);
                  return {
                    accountId: row.account.id,
                    accountName: row.account.name,
                    status: view.detail ? `${view.label} · ${view.detail}` : `${view.label}. No platform is connected.`,
                    connectionId: row.mockConnectionId,
                    otherConnection: row.otherConnection,
                  };
                })}
              />
            )}
          </CardBody>
        </Card>
      )}
      <TechnicalDetails developerMode={data.preferences.developerMode}>
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt>Database version</dt>
          <dd>{data.schemaVersion ?? "unknown"}</dd>
          <dt>User id</dt>
          <dd>{data.user.id}</dd>
          <dt>Time display</dt>
          <dd>
            {data.preferences.timeDisplay.mode}
            {data.preferences.timeDisplay.zone ? ` · ${data.preferences.timeDisplay.zone}` : ""}
          </dd>
          {[...data.active, ...data.archived].map(account => (
            <div key={account.id} className="contents">
              <dt>{account.name}</dt>
              <dd>{account.id}</dd>
            </div>
          ))}
        </dl>
      </TechnicalDetails>
    </Section>
  );
}

export function SettingsPage({ data }: { data: SettingsPageData }) {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Settings"
        description={`Display, AI, connections, your data and account security. Trading days always run on fixed ${STRATEGY_ZONE_LABEL}.`}
      />
      <div className="lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)] lg:gap-10">
        <aside className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 mb-6 border-b border-border bg-bg px-4 py-1.5 md:-mx-6 md:px-6 lg:top-20 lg:mx-0 lg:mb-0 lg:self-start lg:border-0 lg:bg-transparent lg:p-0">
          <SettingsNav />
        </aside>
        <div className="flex min-w-0 max-w-3xl flex-col gap-12">
          <Section id="general" title="General" icon={<SlidersHorizontal />} description="How Trading OS looks and shows times in this browser.">
            <Card>
              <CardBody>
                <GeneralSettings theme={data.preferences.theme} timeDisplay={data.preferences.timeDisplay} nowIso={data.nowIso} />
              </CardBody>
            </Card>
          </Section>
          <AiSection data={data} />
          <ConnectionsSection data={data} />
          <DataSection data={data} />
          <SecuritySection data={data} />
          <DangerSection data={data} />
          <DeveloperSection data={data} />
          <p className="t-caption flex items-center gap-1.5">
            <Monitor aria-hidden="true" className="size-3.5 flex-none" />
            Theme, time display and technical details are saved in this browser. Everything else belongs to your Trading OS login.
          </p>
        </div>
      </div>
    </div>
  );
}
