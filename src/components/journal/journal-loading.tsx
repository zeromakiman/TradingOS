import { LoadingState, Skeleton } from "@/components/ui/skeleton";
import { cx } from "@/components/ui/cx";
import { JOURNAL_COLUMNS } from "./trade-row";

/** Journal skeleton (§13.7): header, search and filter pills, then day groups of rows shaped like the real ones. */

/** Date, Result, State, Model, Tags, Instrument, More filters. */
const PILLS = ["4.5rem", "5rem", "4.5rem", "5rem", "4.25rem", "6.75rem", "7rem"];
const GROUPS = [
  { key: "group-1", rows: 4 },
  { key: "group-2", rows: 3 },
];

function RowSkeleton() {
  return (
    <div className={cx("grid items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:px-4 @min-[60rem]:py-2", JOURNAL_COLUMNS)}>
      <Skeleton className="col-start-1 row-span-3 row-start-1 self-start @min-[60rem]:row-span-1 @min-[60rem]:self-center" width="4rem" height="2.5rem" />
      <span className="col-start-2 row-start-1 flex flex-col gap-1.5 @min-[60rem]:row-span-1">
        <Skeleton width="7.5rem" height="0.875rem" />
        <Skeleton width="9rem" height="0.75rem" className="@min-[60rem]:hidden" />
      </span>
      <Skeleton className="col-start-3 row-start-1 justify-self-end @min-[60rem]:col-start-5" width="3.25rem" height="0.875rem" />
      <Skeleton className="col-start-3 row-start-2 justify-self-end @min-[60rem]:col-start-6 @min-[60rem]:row-start-1" width="4rem" height="0.75rem" />
      <Skeleton className="col-start-2 row-start-3 @min-[60rem]:col-start-7 @min-[60rem]:row-start-1 @min-[60rem]:ml-3" width="6.5rem" height="1.5rem" shape="pill" />
    </div>
  );
}

export function JournalLoading() {
  return (
    <LoadingState label="Loading trades" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton width="8rem" height="2rem" />
        <Skeleton width="min(24rem, 80%)" height="1rem" />
      </div>
      <div className="flex flex-wrap items-center gap-2 md:gap-1.5">
        <Skeleton className="min-w-0 flex-1 md:mr-1 md:w-56 md:flex-none" height="2.5rem" />
        <Skeleton className="md:hidden" width="6.5rem" height="2.5rem" />
        {PILLS.map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder widths
          <Skeleton key={index} className="max-md:hidden" width={width} height="2.5rem" shape="pill" />
        ))}
      </div>
      {GROUPS.map(group => (
        <div key={group.key} className="@container flex flex-col gap-2">
          <Skeleton width="9rem" height="1rem" />
          <div className="card divide-y divide-border overflow-hidden">
            {Array.from({ length: group.rows }, (_, row) => `${group.key}-row-${row}`).map(key => (
              <RowSkeleton key={key} />
            ))}
          </div>
        </div>
      ))}
    </LoadingState>
  );
}
