import { Plus } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "../ui/button";
import { LIVE_TRADE_HREF, PLAN_TRADE_HREF } from "./navigation";
import { LIVE_ACTION_ID, PLAN_ACTION_ID } from "./shortcuts";

/** The two global primary actions (§1.1); `P` and `L` activate them from the keyboard. */
export function PrimaryActions() {
  return (
    <div className="primary-actions">
      <Link id={PLAN_ACTION_ID} href={PLAN_TRADE_HREF} className={buttonClasses({ variant: "primary" })} aria-keyshortcuts="P">
        <Plus aria-hidden="true" />
        Plan Trade
      </Link>
      <Link id={LIVE_ACTION_ID} href={LIVE_TRADE_HREF} className={buttonClasses({ variant: "secondary" })} aria-keyshortcuts="L" aria-label="Record Live Trade">
        <Plus aria-hidden="true" />
        <span>
          <span className="primary-action-long">Record </span>Live Trade
        </span>
      </Link>
    </div>
  );
}
