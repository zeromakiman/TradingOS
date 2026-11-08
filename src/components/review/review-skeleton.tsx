import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { LoadingState, Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { REVIEW_DESCRIPTION, REVIEW_TITLE } from "./copy";
import { type PeriodicTab, REVIEW_TABS, type ReviewTab, TAB_LABELS, TAB_SHORT_LABELS } from "./params";
import { REVIEW_COLUMNS, TAB_STRIP } from "./styles";
import { ReviewTabLabel } from "./tab-label";

/**
 * Loading state of the Review workspace (docs/V2_ARCHITECTURE.md §13.7): the real title and tabs (the selected one
 * marked), then skeletons shaped like the scope card, the review panel and the side column, or like the history list.
 */

function Tabs({ tab }: { tab: ReviewTab }) {
  return (
    <div aria-hidden="true" className={cx("tabs-list", TAB_STRIP)}>
      {REVIEW_TABS.map(item => (
        <span key={item} className="tab" data-state={item === tab ? "active" : undefined}>
          <ReviewTabLabel label={TAB_LABELS[item]} shortLabel={TAB_SHORT_LABELS[item] ?? null} />
        </span>
      ))}
    </div>
  );
}

function Side() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton width="6rem" height="1.25rem" />
        <Card>
          <CardBody className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Skeleton width="7rem" height="1rem" />
              <Skeleton width="3rem" height="1.25rem" shape="pill" />
            </div>
            <Skeleton width="90%" height="0.875rem" />
            <Skeleton width="100%" height="0.375rem" shape="pill" />
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <Skeleton width="11rem" height="1.125rem" />
        </CardHeader>
        <CardBody>
          <SkeletonText lines={5} />
        </CardBody>
      </Card>
    </div>
  );
}

/** The period control: a week or month picker, or the 10 · 20 · 30 trades sample on Recent trades. */
function PeriodControl({ tab }: { tab: PeriodicTab }) {
  if (tab === "recent") {
    return (
      <div className="flex w-full flex-col gap-2">
        <Skeleton width="4rem" height="0.875rem" />
        <Skeleton width="min(17rem, 100%)" height="2.75rem" />
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 @min-[30rem]:w-[24rem]">
      <Skeleton width="4rem" height="0.875rem" />
      <Skeleton width="100%" height="2.5rem" />
    </div>
  );
}

function Periodic({ tab }: { tab: PeriodicTab }) {
  return (
    <div className={REVIEW_COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4">
        {/* Shaped like the scope card: pickers, then the period's facts beside them when the card is wide enough. */}
        <Card className="@container">
          <CardBody className="grid items-start gap-4 @min-[46rem]:grid-cols-[auto_minmax(0,1fr)] @min-[46rem]:gap-6">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex w-full flex-col gap-2 @min-[30rem]:w-[24rem]">
                <Skeleton width="7rem" height="0.875rem" />
                <Skeleton width="100%" height="2.5rem" />
              </div>
              <PeriodControl tab={tab} />
            </div>
            <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3 @min-[46rem]:border-t-0 @min-[46rem]:border-l @min-[46rem]:pt-0 @min-[46rem]:pl-6">
              <Skeleton width="8rem" height="0.75rem" />
              <Skeleton width="min(14rem, 100%)" height="1.25rem" />
              <Skeleton width="min(12rem, 100%)" height="1.25rem" />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton width="9rem" height="1.25rem" />
              <Skeleton width="min(24rem, 100%)" height="0.875rem" />
            </div>
            <Skeleton width="100%" height="3rem" />
            <Skeleton width="16rem" height="2.5rem" />
            <SkeletonText lines={4} />
          </CardBody>
        </Card>
      </div>
      <Side />
    </div>
  );
}

const HISTORY_ROWS = ["row-1", "row-2", "row-3", "row-4", "row-5"];

function History() {
  return (
    <div className={REVIEW_COLUMNS}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex w-full flex-col gap-2 sm:w-60">
            <Skeleton width="7rem" height="0.875rem" />
            <Skeleton width="100%" height="2.5rem" />
          </div>
          <Skeleton width="min(22rem, 100%)" height="2.75rem" />
        </div>
        <Card>
          <CardHeader className="flex-col">
            <Skeleton width="7rem" height="1.25rem" />
            <Skeleton width="min(26rem, 100%)" height="0.875rem" />
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <Skeleton width="5rem" height="0.75rem" />
            {HISTORY_ROWS.map(key => (
              <div key={key} className="flex gap-3">
                <Skeleton width="1rem" height="1rem" shape="circle" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton width="14rem" height="0.875rem" />
                  <Skeleton width="9rem" height="0.75rem" />
                  <Skeleton width="90%" height="0.75rem" />
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      <Side />
    </div>
  );
}

export function ReviewSkeleton({ tab }: { tab: ReviewTab }) {
  return (
    <LoadingState label="Loading review" className="flex flex-col">
      <header className="page-header mb-4">
        <div className="min-w-0">
          {/* The scope line keeps its line height, so the title does not move when the page arrives. */}
          <div className="page-header-eyebrow flex h-[1.5em] items-center">
            <Skeleton width="11rem" height="0.875rem" />
          </div>
          <p className="page-header-title">{REVIEW_TITLE}</p>
          {/* Like the page: phones go straight to the scope and the run button. */}
          <p className="page-header-description hidden sm:block">{REVIEW_DESCRIPTION}</p>
        </div>
      </header>
      <div className="flex flex-col gap-6">
        <Tabs tab={tab} />
        {tab === "history" ? <History /> : <Periodic tab={tab} />}
      </div>
    </LoadingState>
  );
}
