import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * A trade that does not exist or belongs to someone else (docs/V2_ARCHITECTURE.md §13.7): the same answer in both cases,
 * so the page never reveals which trades exist, with the ways back to the trader's own trades.
 */
export default function TradeNotFound() {
  return (
    <section aria-labelledby="trade-not-found-title" className="flex flex-col gap-4">
      <h1 id="trade-not-found-title" className="sr-only">
        Trade not found
      </h1>
      <EmptyState
        icon={<FileQuestion />}
        headingLevel={2}
        title="This trade isn't available."
        description="It may not exist, or it belongs to someone else. Your trades are in the Journal. Nothing was changed."
        actions={
          <>
            <Link href="/journal" className={buttonClasses({ variant: "primary" })}>
              Open the Journal
            </Link>
            <Link href="/today" className={buttonClasses({ variant: "secondary" })}>
              Go to Today
            </Link>
          </>
        }
      />
    </section>
  );
}
