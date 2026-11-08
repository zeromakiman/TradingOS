import { LoadingState, Skeleton } from "@/components/ui/skeleton";

/** Route loading state of Today (§13.7): skeletons shaped like the header, the session ribbon, the status card and lists. */
export function TodayLoading() {
  return (
    <LoadingState label="Loading Today" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton width="9rem" height="0.875rem" />
        <Skeleton width="6rem" height="1.75rem" />
        <Skeleton width="16rem" height="1rem" />
      </div>
      <div className="card flex flex-col gap-3 px-4 py-3 md:px-5">
        <div className="flex justify-between gap-4">
          <Skeleton width="10rem" height="1rem" />
          <Skeleton width="12rem" height="1rem" />
        </div>
        <Skeleton height="2rem" />
      </div>
      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 p-4 md:p-5">
          <Skeleton width="10rem" height="0.75rem" />
          <Skeleton width="18rem" height="1.75rem" />
          <Skeleton height="2.75rem" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border md:grid-cols-3 xl:grid-cols-5">
          {["trades", "risk", "result", "losses", "values"].map(key => (
            <div key={key} className="flex flex-col gap-2 bg-surface px-4 py-3 last:col-span-2 md:px-5 xl:last:col-span-1">
              <Skeleton width="55%" height="0.75rem" />
              <Skeleton width="70%" height="1.5rem" />
              <Skeleton width="80%" height="0.75rem" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton width="9rem" height="1.25rem" />
        <div className="card divide-y divide-border">
          {["one", "two", "three"].map(key => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3 md:px-5">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton width="40%" height="1rem" />
                <Skeleton width="75%" height="0.75rem" />
              </div>
              <Skeleton width="6rem" height="2rem" />
            </div>
          ))}
        </div>
      </div>
    </LoadingState>
  );
}
