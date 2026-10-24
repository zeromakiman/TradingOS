"use client";

import { Archive, ArchiveRestore, LayoutDashboard, MoreHorizontal, Scale, Settings2 } from "lucide-react";
import Link from "next/link";
import { type ReactElement, useRef, useState } from "react";
import { archiveAccount, restoreAccount } from "@/app/actions/accounts";
import { idleState } from "@/app/actions/state";
import { Button, IconButton } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useOptionalToast } from "@/components/ui/toast";
import { ACTIVE_ACCOUNTS_HEADING, ARCHIVE_COPY, manageHref, RESTORE_COPY } from "./copy";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const changed = useRef(false);
  const archiving = status === "ACTIVE";
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
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/accounts/${accountId}`}>
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
        </DropdownMenuContent>
      </DropdownMenu>
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
