"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/empty-state";

/**
 * Route-level error boundary of the app (docs/V2_ARCHITECTURE.md §13.7). It renders inside the shell (the layout
 * stays), never shows raw error text, and offers a retry (re-fetches the segment) and a way back to Today.
 */
export default function AppError({ retry, reset }: { error: Error & { digest?: string }; reset: () => void; retry?: () => void }) {
  return (
    <ErrorState
      headingLevel={1}
      title="This page couldn't load."
      description="Nothing was changed. Try again, or go back to Today."
      retry={<Button onClick={() => (retry ?? reset)()}>Try again</Button>}
      homeHref="/today"
      homeLabel="Go to Today"
    />
  );
}
