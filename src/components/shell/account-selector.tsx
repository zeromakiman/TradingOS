"use client";

import { ChevronDown, Layers, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useState, useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useAccountContextSelection } from "./account-context-sync";
import { switchAccountContext } from "./actions";
import { ALL_ACCOUNTS_LABEL, accountTypeLabel, contextLabel, withAccountParam } from "./navigation";
import type { AccountContextSelection, SelectAccountAction, ShellAccount } from "./types";
import { useCurrentHref } from "./use-current-href";

export type AccountSelectorProps = {
  accounts: ShellAccount[];
  /** The context the layout was rendered with; inside the shell the selector shows the context of the page on screen. */
  context: AccountContextSelection;
  /** Persists the choice (cookie) without changing the URL; without it, or when it fails, the options navigate with `?account=`. */
  selectAccountAction?: SelectAccountAction;
};

const isPlainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Header selector for the trading-account context (§9.2). Every option is a real link to the
 * current page with `?account=all|<id>` (its other parameters kept), so it also works as plain
 * navigation; with JavaScript and a `selectAccountAction`, a click calls the action instead and
 * the page re-renders in place. On a page whose URL names a context (`?account=`), the option's
 * link is followed, because the URL decides what that page shows; the shell then stores the new
 * context (AccountContextSync), so the header, the page and the stored context agree.
 */
export function AccountSelector({ accounts, context: rendered, selectAccountAction }: AccountSelectorProps) {
  const router = useRouter();
  const context = useAccountContextSelection(rendered);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const choose = (event: MouseEvent<HTMLAnchorElement>, value: string, href: string) => {
    if (!isPlainClick(event)) return;
    setOpen(false);
    if (!selectAccountAction || new URL(window.location.href).searchParams.has("account")) return;
    event.preventDefault();
    startTransition(() => switchAccountContext(selectAccountAction, value, href, (target) => router.push(target)));
  };

  return (
    <div className="account-selector">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger className="account-trigger" aria-busy={pending || undefined}>
          <span className="account-trigger-label max-xl:sr-only">Trading Account:</span>
          <span className="account-trigger-value">{contextLabel(accounts, context)}</span>
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-64">
          <AccountMenuItems accounts={accounts} context={context} onChoose={choose} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export type AccountMenuItemsProps = {
  accounts: ShellAccount[];
  context: AccountContextSelection;
  onChoose?: (event: MouseEvent<HTMLAnchorElement>, value: string, href: string) => void;
};

/**
 * Options of the account menu. They render only while the menu is open, so the current URL
 * (path and query) is read when the links are shown.
 */
export function AccountMenuItems({ accounts, context, onChoose }: AccountMenuItemsProps) {
  const currentHref = useCurrentHref();
  const selected = context.mode === "all" ? "all" : context.accountId;
  const active = accounts.filter((account) => account.status === "ACTIVE");
  const archived = accounts.filter((account) => account.status === "ARCHIVED");

  const option = (value: string, name: string, detail: string) => {
    const href = withAccountParam(currentHref, value);
    return (
      <DropdownMenuRadioItem key={value} value={value} asChild>
        <Link href={href} onClick={(event) => onChoose?.(event, value, href)} prefetch={false}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{name}</span>
            <span className="t-caption truncate">{detail}</span>
          </span>
          <DropdownMenuItemIndicator />
        </Link>
      </DropdownMenuRadioItem>
    );
  };

  return (
    <>
      <DropdownMenuRadioGroup value={selected}>
        {option("all", ALL_ACCOUNTS_LABEL, "Aggregate of every trading account")}
        {active.length > 0 && <DropdownMenuLabel>Active</DropdownMenuLabel>}
        {active.map((account) => option(account.id, account.name, `${account.currency} · ${accountTypeLabel(account.type)}`))}
      </DropdownMenuRadioGroup>
      {/* Archived accounts cannot be the working context (§9.2); their history stays on their dashboards. */}
      {archived.length > 0 && <DropdownMenuLabel>Archived</DropdownMenuLabel>}
      {archived.map((account) => (
        <DropdownMenuItem key={account.id} asChild>
          <Link href={`/accounts/${encodeURIComponent(account.id)}`} prefetch={false}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{account.name}</span>
              <span className="t-caption truncate">{`${account.currency} · ${accountTypeLabel(account.type)} · view history`}</span>
            </span>
          </Link>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href="/accounts">
          <Wallet aria-hidden="true" />
          <span className="flex-1">Manage accounts</span>
        </Link>
      </DropdownMenuItem>
      {accounts.length === 0 && (
        <DropdownMenuItem asChild>
          <Link href="/accounts/new">
            <Layers aria-hidden="true" />
            <span className="flex-1">Create a trading account</span>
          </Link>
        </DropdownMenuItem>
      )}
    </>
  );
}
