import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { LoadingState, Skeleton, SkeletonText } from "@/components/ui/skeleton";

/** Skeletons shaped like the Accounts screens (spec §13.7), used by their route `loading.tsx` files. */

function HeaderShape({ eyebrow = false }: { eyebrow?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {eyebrow && <Skeleton width="6rem" height="0.875rem" />}
      <Skeleton width="14rem" height="2rem" />
      <Skeleton width="22rem" height="1rem" className="max-w-full" />
    </div>
  );
}

function StatCardShape({ stats = 5 }: { stats?: number }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton width="9rem" height="1.25rem" />
      </CardHeader>
      <CardBody className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: stats }, (_, index) => `stat-${index}`).map(key => (
          <div key={key} className="flex flex-col gap-2">
            <Skeleton width="60%" height="0.875rem" />
            <Skeleton width="80%" height="1.5rem" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

export function AccountsLoading() {
  return (
    <LoadingState label="Loading trading accounts" className="flex flex-col gap-6">
      <HeaderShape />
      <Card>
        <CardBody className="flex flex-col gap-4">
          {["row-1", "row-2", "row-3"].map(key => (
            <div key={key} className="grid grid-cols-2 items-center gap-4 md:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
              <div className="flex flex-col gap-2">
                <Skeleton width="8rem" height="1rem" />
                <Skeleton width="6rem" height="0.75rem" />
              </div>
              <Skeleton width="70%" height="1rem" />
              <Skeleton width="70%" height="1rem" className="hidden md:block" />
              <Skeleton width="70%" height="1rem" className="hidden md:block" />
              <Skeleton width="50%" height="1rem" className="hidden md:block" />
            </div>
          ))}
        </CardBody>
      </Card>
    </LoadingState>
  );
}

export function AccountDashboardLoading() {
  return (
    <LoadingState label="Loading the account" className="flex flex-col gap-6">
      <HeaderShape eyebrow />
      <StatCardShape stats={4} />
      <StatCardShape />
      <div className="grid gap-4 xl:grid-cols-2">
        {["chart-1", "chart-2"].map(key => (
          <Card key={key}>
            <CardBody className="flex flex-col gap-3">
              <Skeleton width="10rem" height="1.25rem" />
              <Skeleton width="100%" height="14rem" />
            </CardBody>
          </Card>
        ))}
      </div>
    </LoadingState>
  );
}

export function ManageLoading() {
  return (
    <LoadingState label="Loading account settings" className="flex flex-col gap-6">
      <HeaderShape eyebrow />
      <div className="flex gap-3">
        {["tab-1", "tab-2", "tab-3", "tab-4"].map(key => (
          <Skeleton key={key} width="6rem" height="2rem" />
        ))}
      </div>
      <Card>
        <CardBody className="flex flex-col gap-4">
          <Skeleton width="10rem" height="1.25rem" />
          <SkeletonText lines={4} />
        </CardBody>
      </Card>
    </LoadingState>
  );
}
