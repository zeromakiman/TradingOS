import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { LoadingState, Skeleton, SkeletonText } from "@/components/ui/skeleton";

/** Route loading state inside the shell (§13.7): skeletons shaped like a page header, stat cards and a list. */
export default function AppLoading() {
  return (
    <LoadingState label="Loading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton width="12rem" height="1.75rem" />
        <Skeleton width="20rem" height="1rem" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {["stat-1", "stat-2", "stat-3", "stat-4"].map(key => (
          <Card key={key}>
            <CardBody className="flex flex-col gap-2">
              <Skeleton width="45%" height="0.875rem" />
              <Skeleton width="70%" height="1.5rem" />
            </CardBody>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton width="10rem" height="1.25rem" />
        </CardHeader>
        <CardBody>
          <SkeletonText lines={5} />
        </CardBody>
      </Card>
    </LoadingState>
  );
}
