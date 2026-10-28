import { CopyPlus, LockKeyhole, ShieldQuestion } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { DraftToolbar } from "./draft-toolbar";
import {
  blockingCheckOf, draftSource, lastRevisionSource, type LockSummary, lockBlockedReason, lockedLine, lockedSource, lockSummary, type PlanSource, planChecks,
  planFacts,
} from "./model";
import { CheckHistory, PlanFactsList, RiskCheckView, Thesis, TraderChecks } from "./plan-parts";
import { WorkspaceSection } from "./section";
import { StrategyCardSheet } from "./strategy-card-sheet";
import type { TradeExtras } from "./workspace-data";

/**
 * Plan section (docs/V2_ARCHITECTURE.md §2.5, §6.5, §8.1, §14.4). A draft shows its revision, the latest free risk check
 * with its exact reasons, the draft workflow (Edit draft → new revision, Check risk, Lock plan with a confirmation,
 * Discard), the values and checks of the latest revision, the thesis (Before entry) and the pre-trade AI tools. A
 * locked plan shows "Locked 09:12 · Risk Plan V1.0 · ICT V1.0 · immutable", its sealed values, the Risk Engine result
 * at lock and the thesis. A draft that was never locked keeps its last revision readable. Server component.
 */

export interface PlanSectionProps {
  detail: TradeDetail;
  extras: TradeExtras;
  now: string;
  display: TimeDisplay;
  lock: LockSummary | null;
  discardKey: string;
  /** Pre-trade AI tools of a draft (rendered by the page inside a Suspense boundary). */
  ai?: ReactNode;
}

function StrategyAction({ extras }: { extras: TradeExtras }) {
  return extras.strategy ? <StrategyCardSheet card={extras.strategy.card} context={extras.strategy.context} /> : null;
}

function PlanValues({ detail, source, label, checksKnown = true }: { detail: TradeDetail; source: PlanSource; label: string; checksKnown?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <PlanFactsList facts={planFacts(detail, source)} label={label} />
      {checksKnown && <TraderChecks checks={planChecks(source.proposal)} />}
    </div>
  );
}

function NotChecked() {
  return (
    <div className="flex items-start gap-2.5" data-check="unchecked">
      <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-3" />
      <div className="min-w-0">
        <p className="font-medium text-text">Not checked yet</p>
        <p className="t-meta">The free risk check uses today's account values and risk plan. Nothing is reserved until you lock the plan.</p>
      </div>
    </div>
  );
}

function DraftPlan({ detail, extras, now, display, lock, discardKey, ai }: PlanSectionProps & { detail: TradeDetail & { draft: NonNullable<TradeDetail["draft"]> } }) {
  const { draft, state } = detail;
  const source = draftSource(detail) as PlanSource;
  const check = draft.latestCheck;
  // Whether the approval itself still describes the present; on an archived account the toolbar says why nothing can be
  // checked or locked, so a stale approval names no recheck.
  const stale = check?.decision === "APPROVED" && !draft.checkCurrent;
  const archived = detail.account.status === "ARCHIVED";
  return (
    <WorkspaceSection
      id="plan"
      title="Plan"
      meta={archived
        ? `Revision ${draft.revision}`
        : `Revision ${draft.revision} · editing saves revision ${draft.revision + 1}; checks, notes and screenshots stay with the trade`}
      actions={<StrategyAction extras={extras} />}
    >
      {detail.duplicatedFromHref && (
        <p className="t-meta flex items-center gap-1.5">
          <CopyPlus aria-hidden="true" className="size-4 flex-none" />
          <span>
            Duplicated from{" "}
            <Link href={detail.duplicatedFromHref} className="font-medium text-accent underline-offset-2 hover:underline">
              an earlier trade
            </Link>
            .
          </span>
        </p>
      )}
      <div className="flex flex-col gap-4 rounded-card border border-border bg-surface-sunken p-3 sm:p-4" data-panel="draft-check">
        {check ? <RiskCheckView check={check} now={now} display={display} label="Risk check" stale={stale} recheckable={!archived} /> : <NotChecked />}
        <DraftToolbar
          tradeId={detail.tradeId}
          editHref={`${detail.href}/edit`}
          expectedRevision={draft.expectedRevision}
          checkLabel={state.draftCheck === "UNCHECKED" ? "Check risk (free)" : "Recheck risk"}
          lockBlockedReason={lockBlockedReason(state, blockingCheckOf(detail), now)}
          lock={lock ?? lockSummary(detail, null)}
          discardKey={discardKey}
          {...(archived ? { archivedManageHref: `/accounts/${detail.account.id}/manage` } : {})}
        />
      </div>
      <PlanValues detail={detail} source={source} label={`Draft values, revision ${draft.revision}`} />
      <Thesis narrative={draft.proposal.narrative} id="plan-thesis" />
      <CheckHistory checks={detail.checks} now={now} display={display} />
      {ai && <div className="border-t border-border pt-5 empty:hidden">{ai}</div>}
    </WorkspaceSection>
  );
}

function LockedPlan({ detail, extras, now, display }: PlanSectionProps & { detail: TradeDetail & { plan: NonNullable<TradeDetail["plan"]> } }) {
  const { plan } = detail;
  const source = lockedSource(detail) as PlanSource;
  return (
    <WorkspaceSection
      id="plan"
      title="Plan"
      meta={
        <span className="flex items-start gap-1.5">
          <LockKeyhole aria-hidden="true" className="mt-[3px] size-3.5 flex-none" />
          <span className="num">{lockedLine(plan, now, display)}</span>
        </span>
      }
      actions={<StrategyAction extras={extras} />}
    >
      <PlanValues detail={detail} source={source} label="Locked plan values" />
      <Thesis narrative={plan.proposal.narrative} id="plan-thesis" />
      {plan.check && (
        <div className="rounded-card border border-border bg-surface-sunken p-3 sm:p-4">
          <RiskCheckView check={plan.check} now={now} display={display} label="Risk Engine at lock" compact />
        </div>
      )}
      <p className="t-caption flex items-center gap-1.5">
        <LockKeyhole aria-hidden="true" className="size-3.5 flex-none" />
        {plan.immutableNote}
      </p>
    </WorkspaceSection>
  );
}

function NeverLockedPlan({ detail, extras, now, display }: PlanSectionProps) {
  const source = lastRevisionSource(detail, extras.lastProposal);
  const known = extras.lastProposal !== null;
  const revision = detail.revisionCount > 0 ? `revision ${detail.revisionCount}` : "no revision";
  return (
    <WorkspaceSection id="plan" title="Plan" meta={`Draft ${revision} · never locked`}>
      <PlanValues detail={detail} source={source} label="Values of the last draft revision" checksKnown={known} />
      <Thesis narrative={source.proposal.narrative} id="plan-thesis" unavailable={!known} />
      {source.check && (
        <div className="rounded-card border border-border bg-surface-sunken p-3 sm:p-4">
          <RiskCheckView check={source.check} now={now} display={display} label="Last risk check" compact findingsSuffix="" />
        </div>
      )}
      <CheckHistory checks={detail.checks} now={now} display={display} />
    </WorkspaceSection>
  );
}

export function PlanSection(props: PlanSectionProps) {
  const { detail } = props;
  if (detail.origin !== "PLANNED") return null;
  if (detail.plan) return <LockedPlan {...props} detail={{ ...detail, plan: detail.plan }} />;
  if (detail.draft && detail.state.lifecycle === "DRAFT") return <DraftPlan {...props} detail={{ ...detail, draft: detail.draft }} />;
  return <NeverLockedPlan {...props} />;
}
