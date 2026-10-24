import { ReviewSkeleton } from "@/components/review/review-skeleton";

/** `/review` opens on the Weekly tab. */
export default function ReviewLoading() {
  return <ReviewSkeleton tab="weekly" />;
}
