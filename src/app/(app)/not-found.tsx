import { SearchX } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** Not-found state inside the shell (§13.7): an unknown trade, account or page never exposes what exists. */
export default function AppNotFound() {
  return (
    <section aria-labelledby="not-found-title" className="flex flex-col gap-4">
      <h1 id="not-found-title" className="sr-only">
        Page not found
      </h1>
      <EmptyState
        icon={<SearchX />}
        headingLevel={2}
        title="This page isn't available."
        description="The trade, account or page may not exist, or it belongs to someone else. Nothing was changed."
        actions={
          <>
            <Link href="/today" className={buttonClasses({ variant: "primary" })}>
              Go to Today
            </Link>
            <Link href="/journal" className={buttonClasses({ variant: "secondary" })}>
              Open the Journal
            </Link>
          </>
        }
      />
    </section>
  );
}
