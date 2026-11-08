import { Card, CardBody } from "@/components/ui/card";
import { LoadingState, Skeleton } from "@/components/ui/skeleton";

const STATS = ["net", "expectancy", "win", "factor", "drawdown", "closed"];
const FILTERS = ["range", "model", "session", "origin", "instrument"];

function ChartPlaceholder({ tall = false }: { tall?: boolean }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton width="8rem" height="1.125rem" />
            <Skeleton width="12rem" height="0.875rem" />
          </div>
          <Skeleton width="7rem" height="2rem" />
        </div>
        <Skeleton width="100%" height={tall ? "17rem" : "13rem"} />
        <Skeleton width="10rem" height="0.75rem" />
      </CardBody>
    </Card>
  );
}

/** EDGE loading state (§13.7): skeletons shaped like the filter row, the headline card and the first charts. */
export function EdgeSkeleton() {
  return (
    <LoadingState label="Loading EDGE" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton width="9rem" height="0.875rem" />
        <Skeleton width="6rem" height="1.875rem" />
        <Skeleton width="min(28rem, 100%)" height="1rem" />
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(key => (
          <Skeleton key={key} width="10rem" height="2.5rem" />
        ))}
      </div>
      <Card>
        <CardBody className="flex flex-col gap-5">
          <Skeleton width="6rem" height="1.25rem" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
            {STATS.map(key => (
              <div key={key} className="flex flex-col gap-2">
                <Skeleton width="60%" height="0.875rem" />
                <Skeleton width="75%" height="1.75rem" />
                <Skeleton width="85%" height="0.75rem" />
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartPlaceholder tall />
        </div>
        <ChartPlaceholder tall />
      </div>
    </LoadingState>
  );
}
