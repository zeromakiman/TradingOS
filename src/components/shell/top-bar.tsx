import { Activity } from "lucide-react";
import Link from "next/link";
import { AccountSelector } from "./account-selector";
import { PrimaryActions } from "./primary-actions";
import { SearchButton } from "./search-button";
import { StrategyClock } from "./strategy-clock";
import type { AccountContextSelection, SelectAccountAction, ShellAccount } from "./types";

export type TopBarProps = {
  accounts: ShellAccount[];
  context: AccountContextSelection;
  nowIso: string;
  selectAccountAction?: SelectAccountAction;
};

/**
 * Header: Trading Account selector · strategy clock · search · + Plan Trade · + Record Live
 * Trade. Below 768px it compacts to the brand mark, the account selector and a search icon.
 */
export function TopBar({ accounts, context, nowIso, selectAccountAction }: TopBarProps) {
  return (
    <header className="app-topbar">
      <Link href="/today" className="topbar-brand brand-mark" aria-label="Trading OS, go to Today">
        <Activity aria-hidden="true" />
      </Link>
      <AccountSelector accounts={accounts} context={context} selectAccountAction={selectAccountAction} />
      <div className="topbar-desktop">
        <StrategyClock nowIso={nowIso} />
        <span className="topbar-spacer" />
        <SearchButton />
        <PrimaryActions />
      </div>
      <SearchButton compact className="topbar-search-icon" />
    </header>
  );
}
