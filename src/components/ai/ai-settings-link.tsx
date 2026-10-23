import { Settings } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "../ui/button";
import { cx } from "../ui/cx";
import { aiSettingsHref } from "./model";

/**
 * "Open AI settings" for one trading account: the fix route when AI is off or the month's budget can't cover another
 * request. Link styling with a full hit target (40px, 44px on touch; docs/V2_ARCHITECTURE.md §13.5).
 */
export function AiSettingsLink({ accountId, className }: { accountId: string; className?: string }) {
  return (
    <Link href={aiSettingsHref(accountId)} className={buttonClasses({ variant: "link", className: cx("min-h-10 self-start pointer-coarse:min-h-11", className) })}>
      <Settings aria-hidden="true" />
      Open AI settings
    </Link>
  );
}
