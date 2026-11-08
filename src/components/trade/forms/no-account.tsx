import { ChevronLeft, Landmark } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { LIVE_DESCRIPTION, LIVE_TITLE, PLAN_DESCRIPTION, PLAN_TITLE } from "./copy";

/**
 * Plan Trade and Record Live Trade without an active trading account (docs/V2_ARCHITECTURE.md §9.1, §13.7): every trade
 * belongs to one explicit account, so the page explains that and offers to create one (or restore an archived one).
 */

export const NO_ACCOUNT_TITLE = "Create a trading account first";

export function noAccountDescription(kind: "plan" | "live", hasArchived: boolean): string {
  const what = kind === "plan" ? "Plans are checked against an account's risk plan and recorded in it" : "Live trades are recorded in one trading account and count toward its daily limits";
  return hasArchived
    ? `${what}. Your accounts are archived: restore one in Accounts, or create a new one.`
    : `${what}. Add the broker, prop-firm or demo account you trade, with its currency and balance.`;
}

export function NoTradingAccount({ kind, hasArchived }: { kind: "plan" | "live"; hasArchived: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        eyebrow={
          <Link href="/today" className="inline-flex min-h-10 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
            <ChevronLeft aria-hidden="true" className="size-4" />
            Today
          </Link>
        }
        title={kind === "plan" ? PLAN_TITLE : LIVE_TITLE}
        description={kind === "plan" ? PLAN_DESCRIPTION : LIVE_DESCRIPTION}
      />
      <div className="card">
        <EmptyState
          icon={<Landmark />}
          headingLevel={2}
          title={NO_ACCOUNT_TITLE}
          description={noAccountDescription(kind, hasArchived)}
          actions={
            <>
              <Link href="/accounts/new" className={buttonClasses({ variant: "primary" })}>
                Create trading account
              </Link>
              {hasArchived && (
                <Link href="/accounts" className={buttonClasses({ variant: "secondary" })}>
                  Open Accounts
                </Link>
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
