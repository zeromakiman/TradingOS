import { Archive, ArrowRight, Crosshair, Radio } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CreateAccountForm } from "@/components/accounts/create-account-form";
import { NewAccountGuide } from "@/components/accounts/new-account-guide";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  EMPTY_DAY_DESCRIPTION, EMPTY_DAY_TITLE, LIVE_TRADE_COPY, NO_ACTIVE_DESCRIPTION, NO_ACTIVE_TITLE, ONBOARDING_DESCRIPTION, ONBOARDING_TITLE, PLAN_TRADE_COPY,
} from "./copy";
import { STATUS_HEADING_ID } from "./dom-ids";

/**
 * Today's starting points (docs/V2_ARCHITECTURE.md §14.1, §14.12): the empty day leads with the two primary actions and
 * one line each; first run (no trading account yet) shows the onboarding card with the account form; when every
 * account is archived, the way back.
 */

function ActionCard({ href, icon, title, body, primary = false }: { href: string; icon: ReactNode; title: string; body: string; primary?: boolean }) {
  return (
    <Link
      href={href}
      className="group flex min-h-28 items-start gap-4 rounded-card border border-border bg-surface p-4 text-1 no-underline transition-colors hover:border-accent hover:bg-accent-soft md:p-5"
    >
      <span
        className={
          primary
            ? "grid size-10 flex-none place-items-center rounded-control bg-accent text-on-accent [&_svg]:size-5"
            : "grid size-10 flex-none place-items-center rounded-control bg-accent-soft text-accent [&_svg]:size-5"
        }
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5 text-base font-semibold">
          {title}
          <ArrowRight aria-hidden="true" className="size-4 text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
        </span>
        <span className="t-meta">{body}</span>
      </span>
    </Link>
  );
}

export function EmptyDay({ planHref, liveHref }: { planHref: string; liveHref: string }) {
  return (
    <section aria-labelledby="today-empty-title" className="card flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <h2 id="today-empty-title" className="text-lg leading-7 font-semibold text-1">
          {EMPTY_DAY_TITLE}
        </h2>
        <p className="t-meta">{EMPTY_DAY_DESCRIPTION}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ActionCard href={planHref} icon={<Crosshair aria-hidden="true" />} title="Plan Trade" body={PLAN_TRADE_COPY} primary />
        <ActionCard href={liveHref} icon={<Radio aria-hidden="true" />} title="Record Live Trade" body={LIVE_TRADE_COPY} />
      </div>
    </section>
  );
}

export function Onboarding() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]">
      <section aria-labelledby="today-onboarding-title" className="card">
        <div className="flex flex-col gap-1 border-b border-border p-4 md:p-5">
          <h2 id="today-onboarding-title" className="text-lg leading-7 font-semibold text-1">
            {ONBOARDING_TITLE}
          </h2>
          <p className="t-meta">{ONBOARDING_DESCRIPTION}</p>
        </div>
        <div className="p-4 md:p-5">
          {/* Once the account exists the page refreshes into the normal Today; focus moves to the trading status. */}
          <CreateAccountForm focusAfterId={STATUS_HEADING_ID} />
        </div>
      </section>
      <NewAccountGuide />
    </div>
  );
}

export function NoActiveAccounts({ archivedCount }: { archivedCount: number }) {
  return (
    <EmptyState
      className="card"
      headingLevel={2}
      icon={<Archive />}
      title={NO_ACTIVE_TITLE}
      description={`${NO_ACTIVE_DESCRIPTION} ${archivedCount === 1 ? "1 account is archived." : `${archivedCount} accounts are archived.`}`}
      actions={
        <>
          <Link href="/accounts" className={buttonClasses({ variant: "primary" })}>
            Restore an account
          </Link>
          <Link href="/accounts/new" className={buttonClasses({ variant: "secondary" })}>
            Create trading account
          </Link>
        </>
      }
    />
  );
}
