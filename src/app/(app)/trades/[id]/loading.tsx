import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { LoadingState, Skeleton, SkeletonText } from "@/components/ui/skeleton";

/**
 * Loading state of the trade workspace (docs/V2_ARCHITECTURE.md §13.7): skeletons shaped like the page — the header
 * with its title, pills and action, the progress strip, the main column (plan and execution) and the side column
 * (journal and evidence).
 */

function SectionSkeleton({ id, lines, grid = false }: { id: string; lines: number; grid?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton width="7rem" height="1.25rem" />
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {grid && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {["a", "b", "c", "d", "e", "f", "g", "h"].map(cell => (
              <div key={`${id}-${cell}`} className="flex flex-col gap-1.5">
                <Skeleton width="50%" height="0.75rem" />
                <Skeleton width="75%" height="1rem" />
              </div>
            ))}
          </div>
        )}
        <SkeletonText lines={lines} />
      </CardBody>
    </Card>
  );
}

export default function TradeLoading() {
  return (
    <LoadingState label="Loading trade" className="flex flex-col gap-5 lg:gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton width="4.5rem" height="1rem" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <Skeleton width="11rem" height="2rem" />
              <Skeleton width="7rem" height="1.5rem" shape="pill" />
              <Skeleton width="4.5rem" height="1.5rem" shape="pill" />
            </div>
            <Skeleton width="18rem" height="1rem" />
          </div>
          <div className="flex gap-2">
            <Skeleton width="8.5rem" height="2.5rem" />
            <Skeleton width="2.5rem" height="2.5rem" />
          </div>
        </div>
      </div>
      <Skeleton width="100%" height="3.25rem" />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_28rem] xl:gap-6">
        <div className="flex min-w-0 flex-col gap-5 xl:gap-6">
          <SectionSkeleton id="plan" lines={3} grid />
          <SectionSkeleton id="execution" lines={4} />
        </div>
        <div className="flex min-w-0 flex-col gap-5 xl:gap-6">
          <SectionSkeleton id="journal" lines={6} />
          <SectionSkeleton id="evidence" lines={2} />
        </div>
      </div>
    </LoadingState>
  );
}
