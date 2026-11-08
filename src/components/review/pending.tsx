"use client";

import { createContext, type ReactNode, type TransitionStartFunction, useContext, useTransition } from "react";
import { Refetching } from "@/components/ui/skeleton";

/**
 * Account and period changes navigate inside a transition: the previous review stays visible, dimmed, until the new
 * one arrives (docs/V2_ARCHITECTURE.md §13.7, "refetch keeps the previous render dimmed").
 */

type ReviewTransitionValue = { pending: boolean; start: TransitionStartFunction };

const ReviewTransitionContext = createContext<ReviewTransitionValue | null>(null);

export function ReviewTransition({ children }: { children: ReactNode }) {
  const [pending, start] = useTransition();
  return <ReviewTransitionContext.Provider value={{ pending, start }}>{children}</ReviewTransitionContext.Provider>;
}

/** The page transition; outside the provider a local one. */
export function useReviewTransition(): ReviewTransitionValue {
  const shared = useContext(ReviewTransitionContext);
  const [pending, start] = useTransition();
  return shared ?? { pending, start };
}

/** Content that dims while an account or period change loads. */
export function ReviewPendingRegion({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useReviewTransition();
  return (
    <Refetching pending={pending} className={className}>
      {children}
    </Refetching>
  );
}
