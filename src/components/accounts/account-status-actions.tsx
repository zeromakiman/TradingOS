"use client";

import { Archive, ArchiveRestore, LayoutDashboard, MoreHorizontal, Scale, Settings2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { accountTradeCount, archiveAccount, deleteTradingAccount, restoreAccount } from "@/app/actions/accounts";
import { idleState } from "@/app/actions/state";
import { Button, IconButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { prefetchFor } from "@/components/ui/links";
import { useOptionalToast } from "@/components/ui/toast";
import { ACTIVE_ACCOUNTS_HEADING, ARCHIVE_COPY, accountDashboardHref, DELETE_ACCOUNT_COPY, manageHref, RESTORE_COPY } from "./copy";
import { restoreFocusAfterDialog } from "./focus";

/** Archive / Restore with confirmation (spec §14.7, §14.9). The account and its history are never deleted. */

type Status = "ACTIVE" | "ARCHIVED";

export interface AccountStatusDialogProps {
  accountId: string;
  name: string;
  status: Status;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called when the account was archived or restored, before the dialog closes. */
  onChanged?: () => void;
}

export function AccountStatusDialog({ accountId, name, status, trigger, open, onOpenChange, onChanged }: AccountStatusDialogProps) {
  const toast = useOptionalToast();
  const archiving = status === "ACTIVE";

  const confirm = async () => {
    const form = new FormData();
    form.set("accountId", accountId);
    const result = await (archiving ? archiveAccount : restoreAccount)(idleState, form);
    if (result.status === "success") {
      toast?.toast({ title: result.message ?? (archiving ? "Account archived." : "Account restored."), tone: "positive" });
      onChanged?.();
    }
    return result;
  };

  return (
    <ConfirmDialog
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      title={archiving ? `Archive ${name}?` : `Restore ${name}?`}
      description={archiving ? ARCHIVE_COPY : RESTORE_COPY}
      confirmLabel={archiving ? "Archive account" : "Restore account"}
      pendingLabel={archiving ? "Archiving…" : "Restoring…"}
      tone={archiving ? "danger" : "primary"}
      onConfirm={confirm}
    >
      <ul className="flex list-disc flex-col gap-1 pl-5 t-meta">
        {archiving ? (
          <>
            <li>Its trades, journal, screenshots and reviews stay readable on its dashboard.</li>
            <li>It leaves the account selector and can't be chosen for new plans or live trades.</li>
            <li>You can restore it at any time.</li>
          </>
        ) : (
          <>
            <li>It returns to the account selector and can take new trades.</li>
            <li>Its risk plan, instruments and history are unchanged.</li>
          </>
        )}
      </ul>
    </ConfirmDialog>
  );
}

/** Button form for the Manage page. */
export function AccountStatusButton({ accountId, name, status }: { accountId: string; name: string; status: Status }) {
  const archiving = status === "ACTIVE";
  return (
    <AccountStatusDialog
      accountId={accountId}
      name={name}
      status={status}
      trigger={
        <Button variant={archiving ? "secondary" : "primary"} icon={archiving ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}>
          {archiving ? "Archive account…" : "Restore account…"}
        </Button>
      }
    />
  );
}

/**
 * Row menu of the Accounts table: open, manage, update values, archive or restore. The confirmation opens from a menu
 * item that is gone by the time it closes, so focus is given back here (§13.5): to this menu button after Cancel or
 * Escape, or to the Active accounts heading once the account moved between the active and archived groups.
 */
export function AccountRowMenu({ accountId, name, status }: { accountId: string; name: string; status: Status }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const pendingDelete = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const changed = useRef(false);
  const archiving = status === "ACTIVE";
  const dashboardHref = accountDashboardHref({ id: accountId, status });
  const onOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (open) {
      changed.current = false;
      return;
    }
    const moved = changed.current;
    restoreFocusAfterDialog(() => (!moved && triggerRef.current?.isConnected ? triggerRef.current : document.getElementById(ACTIVE_ACCOUNTS_HEADING)));
  };
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton ref={triggerRef} label={`Actions for ${name}`} icon={<MoreHorizontal aria-hidden="true" />} size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={event => {
            if (!pendingDelete.current) return;
            pendingDelete.current = false;
            event.preventDefault();
            setDeleteOpen(true);
          }}
        >
          <DropdownMenuItem asChild>
            <Link href={dashboardHref} prefetch={prefetchFor(dashboardHref, undefined)}>
              <LayoutDashboard aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Open dashboard</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={manageHref(accountId)}>
              <Settings2 aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Manage</span>
            </Link>
          </DropdownMenuItem>
          {archiving && (
            <DropdownMenuItem asChild>
              <Link href={manageHref(accountId, "account-values")}>
                <Scale aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">Update account values</span>
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={archiving ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />} onSelect={() => onOpenChange(true)}>
            {archiving ? "Archive…" : "Restore…"}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Trash2 aria-hidden="true" />} className="text-neg" onSelect={() => { pendingDelete.current = true; }}>
            Delete trading account…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAccountDialog
        accountId={accountId}
        name={name}
        status={status}
        open={deleteOpen}
        onOpenChange={open => {
          setDeleteOpen(open);
          if (!open) restoreFocusAfterDialog(() => (triggerRef.current?.isConnected ? triggerRef.current : document.getElementById(ACTIVE_ACCOUNTS_HEADING)));
        }}
      />
      <AccountStatusDialog
        accountId={accountId}
        name={name}
        status={status}
        open={dialogOpen}
        onOpenChange={onOpenChange}
        onChanged={() => {
          changed.current = true;
        }}
      />
    </>
  );
}

export interface DeleteAccountDialogProps {
  accountId: string;
  name: string;
  status: Status;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** "12 trades will be deleted": every trade of the account, of any origin and state, Deleted trades included. */
export function tradeCountTitle(count: number | null | undefined): string {
  if (count === undefined) return "Counting the account's trades…";
  if (count === null) return "Every trade of the account is deleted too";
  return count === 0 ? "This account has no trades" : `${count} trade${count === 1 ? "" : "s"} will be deleted`;
}

/**
 * Delete trading account (0020): the account's total trade count (every origin and state, Deleted trades included,
 * read when the dialog opens), the warning, Archive as the alternative (also after a refusal), the typed name and, when
 * it has trades, the explicit confirmation that they are deleted too. The database refuses while any trade is open or
 * counts toward today's limits, an AI request is in flight, or AI history exists; nothing is deleted then.
 */
export function DeleteAccountDialog({ accountId, name, status, trigger, open, onOpenChange }: DeleteAccountDialogProps) {
  const toast = useOptionalToast();
  const router = useRouter();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const [typed, setTyped] = useState("");
  const [withTrades, setWithTrades] = useState(false);
  // undefined while it is read; null when it couldn't be read.
  const [count, setCount] = useState<number | null | undefined>(undefined);
  const [archiving, startArchive] = useTransition();
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const setOpen = (next: boolean) => {
    if (!next) {
      setTyped("");
      setWithTrades(false);
      setArchiveError(null);
    }
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (!isOpen) return;
    let current = true;
    setCount(undefined);
    accountTradeCount(accountId).then(value => { if (current) setCount(value); }, () => { if (current) setCount(null); });
    return () => { current = false; };
  }, [isOpen, accountId]);
  const confirm = async () => {
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("confirmName", typed);
    if (withTrades) form.set("deleteTrades", "on");
    const result = await deleteTradingAccount(idleState, form);
    if (result.status === "success") {
      toast?.toast({ title: result.message ?? "Trading account deleted.", tone: "positive" });
      router.push("/accounts?account=all");
    }
    return result;
  };
  const archive = () => startArchive(async () => {
    const form = new FormData();
    form.set("accountId", accountId);
    const result = await archiveAccount(idleState, form).catch(() => ({ status: "error" as const, message: "The account could not be archived. Please try again." }));
    if (result.status === "success") {
      toast?.toast({ title: result.message ?? "Account archived.", tone: "positive" });
      setOpen(false);
      router.refresh();
    } else if (result.status === "error") setArchiveError(result.message);
  });
  return (
    <ConfirmDialog
      trigger={trigger}
      open={isOpen}
      onOpenChange={setOpen}
      tone="danger"
      title={`Delete ${name}?`}
      description={DELETE_ACCOUNT_COPY.description}
      confirmLabel="Delete account"
      pendingLabel="Deleting…"
      confirmDisabled={typed !== name}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Callout tone="warning" title={tradeCountTitle(count)}>
          {count ? "Drafts, skipped, cancelled and discarded trades and those in Deleted trades are included. " : ""}
          {DELETE_ACCOUNT_COPY.warning}
        </Callout>
        {status === "ACTIVE" && (
          <div className="flex flex-col gap-2 rounded-control border border-border p-3">
            <p className="t-meta">{DELETE_ACCOUNT_COPY.archiveAlternative}</p>
            <div>
              <Button variant="secondary" size="sm" icon={<Archive aria-hidden="true" />} loading={archiving} loadingText="Archiving…" onClick={archive}>
                Archive instead
              </Button>
            </div>
            {archiveError && <p role="alert" className="t-caption text-neg">{archiveError}</p>}
          </div>
        )}
        <Checkbox checked={withTrades} onChange={event => setWithTrades(event.target.checked)} label="Also delete every trade of this account, with its journal, screenshots and AI results" />
        <Field label={`Type the account name (${name}) to confirm`} required>
          <Input value={typed} autoComplete="off" spellCheck={false} onChange={event => setTyped(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

/** Button form for Manage → Profile. */
export function DeleteAccountButton(props: Omit<DeleteAccountDialogProps, "trigger" | "open" | "onOpenChange">) {
  return <DeleteAccountDialog {...props} trigger={<Button variant="danger" icon={<Trash2 aria-hidden="true" />}>Delete trading account…</Button>} />;
}
