"use client";

import { Archive, ArchiveRestore, LayoutDashboard, MoreHorizontal, Scale, Settings2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactElement, useRef, useState } from "react";
import { archiveAccount, deleteTradingAccount, restoreAccount } from "@/app/actions/accounts";
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
export function AccountRowMenu({ accountId, name, status, trades = null }: { accountId: string; name: string; status: Status; trades?: KnownTrades | null }) {
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
        trades={trades}
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

/** What the row knows about the account's trades (closed and live counts), when it knows it. */
export interface KnownTrades {
  closed: number;
  live: number;
}

export interface DeleteAccountDialogProps {
  accountId: string;
  name: string;
  status: Status;
  trades?: KnownTrades | null;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Delete trading account (0020): the warning, the Archive alternative, the typed name and, when it has trades, the
 * explicit confirmation that they are deleted too. The database refuses while any trade is open or counts toward today's
 * limits, an AI request is in flight, or AI history exists (archive instead); nothing is deleted then.
 */
export function DeleteAccountDialog({ accountId, name, status, trades, trigger, open, onOpenChange }: DeleteAccountDialogProps) {
  const toast = useOptionalToast();
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [withTrades, setWithTrades] = useState(false);
  const reset = () => {
    setTyped("");
    setWithTrades(false);
  };
  const confirm = async () => {
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("confirmName", typed);
    if (withTrades) form.set("deleteTrades", "on");
    const result = await deleteTradingAccount(idleState, form);
    if (result.status === "success") {
      toast?.toast({ title: result.message ?? "Trading account deleted.", tone: "positive" });
      reset();
      router.push("/accounts?account=all");
    }
    return result;
  };
  const count = trades ? trades.closed + trades.live : null;
  return (
    <ConfirmDialog
      trigger={trigger}
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange?.(next);
      }}
      tone="danger"
      title={`Delete ${name}?`}
      description={DELETE_ACCOUNT_COPY.description}
      confirmLabel="Delete account"
      pendingLabel="Deleting…"
      confirmDisabled={typed !== name}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Callout tone="warning" title={count === null ? "Its trades are deleted too" : count === 0 ? "No closed or live trades recorded" : `${count} trade${count === 1 ? "" : "s"} will be deleted`}>
          {trades && trades.live > 0 ? `${trades.live} live trade${trades.live === 1 ? " is" : "s are"} still open: close ${trades.live === 1 ? "it" : "them"} first. ` : ""}
          {DELETE_ACCOUNT_COPY.warning}
        </Callout>
        {status === "ACTIVE" && <p className="t-meta">{DELETE_ACCOUNT_COPY.archiveAlternative}</p>}
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
