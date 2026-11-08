import { LoadingState, Skeleton } from "@/components/ui/skeleton";

/**
 * Loading states of the trade forms (docs/V2_ARCHITECTURE.md §13.7): skeletons shaped like the page header, the
 * numbered form sections and, for planning, the risk check preview beside them.
 */

function HeaderShape() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton width="5rem" height="0.875rem" />
      <Skeleton width="12rem" height="2rem" />
      <Skeleton width="26rem" height="1rem" className="max-w-full" />
    </div>
  );
}

function FieldShape({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton width={wide ? "7rem" : "4.5rem"} height="0.875rem" />
      <Skeleton width="100%" height="2.5rem" />
    </div>
  );
}

function SectionShape({ fields, columns }: { fields: number; columns: 2 | 3 }) {
  return (
    <div className="flex flex-col gap-4 border-border border-t px-4 py-5 first:border-t-0 md:px-5">
      <div className="flex items-center gap-2.5">
        <Skeleton width="1.5rem" height="1.5rem" shape="circle" />
        <Skeleton width="8rem" height="1.125rem" />
      </div>
      <div className={columns === 3 ? "grid gap-4 sm:grid-cols-3" : "grid gap-4 md:grid-cols-2"}>
        {Array.from({ length: fields }, (_, index) => `field-${index}`).map(key => (
          <FieldShape key={key} wide={columns === 2} />
        ))}
      </div>
    </div>
  );
}

export function PlanFormLoading({ label = "Loading Plan Trade" }: { label?: string }) {
  return (
    <LoadingState label={label} className="flex flex-col gap-5">
      <HeaderShape />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)] xl:gap-6">
        <div className="card">
          <SectionShape fields={2} columns={2} />
          <SectionShape fields={3} columns={3} />
          <SectionShape fields={1} columns={2} />
        </div>
        <div className="card flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between">
            <Skeleton width="9rem" height="1.25rem" />
            <Skeleton width="5rem" height="1.5rem" shape="pill" />
          </div>
          <Skeleton width="100%" height="9rem" />
          <Skeleton width="100%" height="2.75rem" />
        </div>
      </div>
    </LoadingState>
  );
}

export function LiveFormLoading() {
  return (
    <LoadingState label="Loading Record Live Trade" className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <HeaderShape />
      <div className="card">
        <SectionShape fields={3} columns={2} />
        <SectionShape fields={2} columns={2} />
      </div>
    </LoadingState>
  );
}
