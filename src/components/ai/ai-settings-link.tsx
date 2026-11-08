import { ArchiveRestore, Settings } from "lucide-react";
import Link from "next/link";
import { manageHref } from "../accounts/copy";
import { buttonClasses } from "../ui/button";
import { cx } from "../ui/cx";
import { prefetchFor } from "../ui/links";
import { aiSettingsHref } from "./model";

/**
 * The fix route when AI is off or the month's budget can't cover another request. Link styling with a full hit target
 * (40px, 44px on touch; docs/V2_ARCHITECTURE.md §13.5).
 *
 * - An active account: "Open AI settings" selects the account (`?account=`), so it is never prefetched (§9.2).
 * - An archived account can never be the context, and Settings → AI shows it read-only until it is restored ("Restore
 *   an account to change its AI settings"): "Restore in Manage" opens its Manage account page, where Restore lives.
 *   The reason beside it (`availabilityReason`, `aiBudgetStatus`) says the same.
 */
export function AiSettingsLink({ accountId, archived = false, className }: { accountId: string; archived?: boolean; className?: string }) {
  const href = archived ? manageHref(accountId) : aiSettingsHref(accountId);
  return (
    <Link
      href={href}
      prefetch={prefetchFor(href, undefined)}
      className={buttonClasses({ variant: "link", className: cx("min-h-10 self-start pointer-coarse:min-h-11", className) })}
    >
      {archived ? <ArchiveRestore aria-hidden="true" /> : <Settings aria-hidden="true" />}
      {archived ? "Restore in Manage" : "Open AI settings"}
    </Link>
  );
}
