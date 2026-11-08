"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { buttonClasses } from "../ui/button";
import { LIVE_TRADE_HREF, newTradeAction, PLAN_TRADE_HREF } from "./navigation";
import { LIVE_ACTION_ID, PLAN_ACTION_ID } from "./shortcuts";

/**
 * The current page's action carries a tab-like bar along its bottom edge in its own text colour, so the header shows
 * where the person is without looking like the focus ring; the outlined action also takes the sidebar's current tint.
 */
const CURRENT = "aria-[current=page]:shadow-[inset_0_-3px_0_0_currentColor]";
const CURRENT_OUTLINED = `${CURRENT} aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent`;

/**
 * The two global primary actions (§1.1); `P` and `L` activate them from the keyboard. On Plan Trade and Record Live
 * Trade the matching action is the current page (`aria-current`), since those forms belong to no navigation section.
 */
export function PrimaryActions() {
  const current = newTradeAction(usePathname());
  return (
    <div className="primary-actions">
      <Link
        id={PLAN_ACTION_ID}
        href={PLAN_TRADE_HREF}
        className={buttonClasses({ variant: "primary", className: CURRENT })}
        aria-keyshortcuts="P"
        aria-current={current === "plan" ? "page" : undefined}
      >
        <Plus aria-hidden="true" />
        Plan Trade
      </Link>
      <Link
        id={LIVE_ACTION_ID}
        href={LIVE_TRADE_HREF}
        className={buttonClasses({ variant: "secondary", className: CURRENT_OUTLINED })}
        aria-keyshortcuts="L"
        aria-label="Record Live Trade"
        aria-current={current === "live" ? "page" : undefined}
      >
        <Plus aria-hidden="true" />
        <span>
          <span className="primary-action-long">Record </span>Live Trade
        </span>
      </Link>
    </div>
  );
}
