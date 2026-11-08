import { Card, CardBody } from "@/components/ui/card";
import { LoadingState, Skeleton, SkeletonText } from "@/components/ui/skeleton";

/** Settings loading state (docs/V2_ARCHITECTURE.md §13.7): header, the section list and the first sections' cards. */
export default function SettingsLoading() {
  return (
    <LoadingState label="Loading settings" className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton width="9rem" height="2rem" />
        <Skeleton width="min(28rem, 100%)" height="1rem" />
      </div>
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)] lg:gap-10">
        <div className="flex gap-2 overflow-hidden lg:flex-col">
          {["general", "ai", "connections", "data", "security", "danger", "developer"].map(key => (
            <Skeleton key={key} width="7rem" height="2.5rem" />
          ))}
        </div>
        <div className="flex max-w-3xl flex-col gap-10">
          {["first", "second"].map(key => (
            <div key={key} className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <Skeleton width="2.25rem" height="2.25rem" />
                <Skeleton width="10rem" height="1.5rem" />
              </div>
              <Card>
                <CardBody className="flex flex-col gap-4">
                  <SkeletonText lines={3} />
                  <Skeleton width="100%" height="5rem" />
                </CardBody>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </LoadingState>
  );
}
