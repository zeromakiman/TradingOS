"use client";

import { ShieldCheck } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useState, useTransition } from "react";
import { type CheckResult, checkRisk } from "@/app/actions/trades";
import { type ActionState, idleState } from "@/app/actions/state";
import { Button } from "@/components/ui/button";
import { useOptionalToast } from "@/components/ui/toast";

/**
 * Runs the free deterministic risk check of a draft right from Today (docs/V2_ARCHITECTURE.md §2.4, §8.1): "Check risk
 * (free)" for an unchecked draft, "Recheck risk" when an approval is no longer current. The result is announced, and
 * the action revalidates Today, so the row shows "Ready to lock" or "Blocked" with its first reason in place.
 */

export const CHECK_UNREACHABLE_COPY = "The risk check didn't reach Trading OS. Nothing was changed. Check your connection and try again.";

export function CheckRiskButton({ tradeId, label, title }: { tradeId: string; label: string; title: string }) {
  const toast = useOptionalToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("tradeId", tradeId);
      let result: ActionState<CheckResult>;
      try {
        result = await checkRisk(idleState, form);
      } catch (failure) {
        unstable_rethrow(failure);
        result = { status: "error", message: CHECK_UNREACHABLE_COPY };
      }
      if (result.status === "success") {
        toast?.toast({ title: result.message ?? "Risk check finished.", description: title, tone: result.data?.decision === "APPROVED" ? "positive" : "warning" });
      } else if (result.status === "error") {
        setError(result.message);
      }
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" variant="secondary" size="sm" icon={<ShieldCheck aria-hidden="true" />} loading={pending} loadingText="Checking…" aria-label={`${label}: ${title}`} onClick={run}>
        {label}
      </Button>
      {error && (
        <span role="alert" className="field-error max-w-72 text-right">
          {error}
        </span>
      )}
    </span>
  );
}
