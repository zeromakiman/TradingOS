"use client";

import { CheckCheck, Ellipsis, Filter, Pencil, Plus, RefreshCw, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { confirmAccountValuesUnchanged } from "@/app/actions/accounts";
import { UpdateValuesForm } from "@/components/accounts/account-values-forms";
import { ADD_EXTERNAL_LOSS, CONFIRM_UNCHANGED, EXTERNAL_LOSS_HELPER, EXTERNAL_LOSS_SYNC_NOTE, UPDATE_VALUES } from "@/components/accounts/copy";
import { restoreFocusAfterDialog, restoreFocusWhenGone } from "@/components/accounts/focus";
import { AddExternalLossForm } from "@/components/accounts/manage-external-losses";
import { useAccountAction } from "@/components/accounts/use-account-action";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useOptionalToast } from "@/components/ui/toast";

/**
 * Inline status actions of Today (docs/V2_ARCHITECTURE.md §8.4, §14.1). "Confirm unchanged" records the values shown
 * beside it as today's in one click; Update account values and Add external loss open dialogs with the Accounts forms
 * (same validation, actions and copy as Manage account). Each account's two dialogs are mounted once beside its status,
 * never inside the reason they resolve, so a dialog closes by itself once the page shows the recorded change, says so,
 * and gives focus back to the button that opened it, or to the account's heading when that button left with the reason
 * (§13.5). A refused submission keeps the dialog open with its message. Stale usage offers a refresh.
 */

/** Runs `onChange` when `signal` changes while `open`: the server render now reflects the submitted change. */
function useChangedWhileOpen(signal: string, open: boolean, onChange: () => void) {
  const seen = useRef(signal);
  const latest = useRef({ open, onChange });
  useEffect(() => {
    latest.current = { open, onChange };
  });
  useEffect(() => {
    if (seen.current === signal) return;
    seen.current = signal;
    if (latest.current.open) latest.current.onChange();
  }, [signal]);
}

/** One account's latest values, as the dialogs and Confirm unchanged show them. */
export interface StatusValues {
  balance: string | null;
  equity: string | null;
  /** "Balance $111,132.01 · Equity $111,132.01" (the latest values), or null. */
  valuesText: string | null;
  /** "Recorded Oct 21" when not today, else null. */
  recorded: string | null;
  /** The latest values' handle: a new one means values were recorded. Null when none were ever recorded. */
  observationId: string | null;
}

export interface StatusAccount {
  accountId: string;
  name: string;
  currency: string;
  canAddExternalLoss: boolean;
  /** Today's external losses (exact decimal): a change means an entry was recorded. */
  external: string;
  /** "External realized losses today: $25.00". */
  externalSummary: string;
  values: StatusValues;
}

/** Accessible name of Confirm unchanged: the values it records ("Confirm unchanged: FTMO 100K, Balance … (recorded Oct 21)"). */
export function confirmUnchangedName(accountName: string, valuesText: string | null, recorded: string | null): string {
  const values = valuesText ? `, ${valuesText}` : "";
  const day = recorded ? ` (${recorded.charAt(0).toLowerCase()}${recorded.slice(1)})` : "";
  return `${CONFIRM_UNCHANGED}: ${accountName}${values}${day}`;
}

export interface ConfirmValuesButtonProps {
  accountId: string;
  accountName: string;
  observationId: string;
  valuesText: string | null;
  recorded: string | null;
  variant?: "primary" | "secondary";
  /** Inside a dialog the dialog announces the result when it closes. */
  silent?: boolean;
  /** Id of the element that takes focus once the button leaves with the reason it resolved. */
  focusAfterId?: string;
}

/** "Confirm unchanged": today's values are the ones shown (refused when newer values exist). */
export function ConfirmValuesButton({ accountId, accountName, observationId, valuesText, recorded, variant = "primary", silent = false, focusAfterId }: ConfirmValuesButtonProps) {
  const toast = useOptionalToast();
  const control = useRef<HTMLSpanElement>(null);
  const { state, pending, run } = useAccountAction(confirmAccountValuesUnchanged, result => {
    if (!silent) toast?.toast({ title: result.message ?? "Balance confirmed for today.", description: accountName, tone: "positive" });
    if (focusAfterId) restoreFocusWhenGone(control.current, () => document.getElementById(focusAfterId));
  });
  const confirm = () => {
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("observationId", observationId);
    run(form);
  };
  return (
    <span ref={control} className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={variant}
        size="sm"
        icon={<CheckCheck aria-hidden="true" />}
        loading={pending}
        loadingText="Confirming…"
        aria-label={confirmUnchangedName(accountName, valuesText, recorded)}
        onClick={confirm}
      >
        {CONFIRM_UNCHANGED}
      </Button>
      {state.status === "error" && (
        <span role="alert" className="field-error">
          {state.message}
        </span>
      )}
    </span>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ExternalLossDialog({ account, open, onOpenChange }: DialogProps & { account: StatusAccount }) {
  const toast = useOptionalToast();
  useChangedWhileOpen(account.external, open, () => {
    onOpenChange(false);
    toast?.toast({ title: "External loss added", description: `${account.name}: today's realized losses include it now.`, tone: "positive" });
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={ADD_EXTERNAL_LOSS} description={EXTERNAL_LOSS_HELPER} size="sm">
        <div className="flex flex-col gap-4">
          <div className="rounded-control border border-border bg-surface-sunken px-3 py-2">
            <p className="text-sm font-medium text-1">{account.name}</p>
            <p className="t-meta">{account.externalSummary}</p>
          </div>
          <AddExternalLossForm accountId={account.accountId} currency={account.currency} />
          <p className="t-caption">{EXTERNAL_LOSS_SYNC_NOTE}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountValuesDialog({ account, open, onOpenChange }: DialogProps & { account: StatusAccount }) {
  const toast = useOptionalToast();
  const { values } = account;
  useChangedWhileOpen(values.observationId ?? "", open, () => {
    onOpenChange(false);
    toast?.toast({ title: "Account values recorded for today", description: account.name, tone: "positive" });
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={UPDATE_VALUES} description={`${account.name} · Recorded for today (UTC−5). Plans lock only when today's balance is recorded.`} size="sm">
        <div className="flex flex-col gap-4">
          {values.observationId && values.valuesText && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-surface-sunken px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-1 num">{values.valuesText}</p>
                {values.recorded && <p className="t-caption">{values.recorded}</p>}
              </div>
              <ConfirmValuesButton
                accountId={account.accountId}
                accountName={account.name}
                observationId={values.observationId}
                valuesText={values.valuesText}
                recorded={values.recorded}
                variant="secondary"
                silent
              />
            </div>
          )}
          {values.observationId && <p className="t-meta">Or enter the balance and equity your broker shows now:</p>}
          <UpdateValuesForm accountId={account.accountId} currency={account.currency} balance={values.balance} equity={values.equity} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

type StatusDialog = "values" | "loss";

interface StatusDialogsApi {
  account: StatusAccount;
  /** Opens a dialog; `trigger` gets focus back when it closes (if it is still on the page). */
  open(kind: StatusDialog, trigger: HTMLElement | null): void;
}

const StatusDialogsContext = createContext<StatusDialogsApi | null>(null);

function useStatusDialogs(): StatusDialogsApi {
  const api = useContext(StatusDialogsContext);
  if (!api) throw new Error("Status actions must be rendered inside <AccountStatusDialogs>.");
  return api;
}

/** The account's dialogs, mounted once around its status card or row. */
export function AccountStatusDialogs({ account, focusFallbackId, children }: { account: StatusAccount; focusFallbackId: string; children: ReactNode }) {
  const [open, setOpen] = useState<StatusDialog | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const api = useMemo<StatusDialogsApi>(() => ({
    account,
    open: (kind, element) => {
      trigger.current = element;
      setOpen(kind);
    },
  }), [account]);
  const onOpenChange = (kind: StatusDialog) => (next: boolean) => {
    if (next) {
      setOpen(kind);
      return;
    }
    setOpen(null);
    restoreFocusAfterDialog(() => (trigger.current?.isConnected ? trigger.current : document.getElementById(focusFallbackId)));
  };
  return (
    <StatusDialogsContext.Provider value={api}>
      {children}
      {account.canAddExternalLoss && <ExternalLossDialog account={account} open={open === "loss"} onOpenChange={onOpenChange("loss")} />}
      <AccountValuesDialog account={account} open={open === "values"} onOpenChange={onOpenChange("values")} />
    </StatusDialogsContext.Provider>
  );
}

/** Opens the account's Update values (Record account values without any) or Add external loss dialog. */
export function StatusDialogButton({ kind, variant = "ghost" }: { kind: StatusDialog; variant?: "primary" | "secondary" | "ghost" }) {
  const dialogs = useStatusDialogs();
  const first = kind === "values" && dialogs.account.values.observationId === null;
  const label = kind === "loss" ? ADD_EXTERNAL_LOSS : first ? "Record account values" : "Update values";
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      icon={kind === "loss" || first ? <Plus aria-hidden="true" /> : <Pencil aria-hidden="true" />}
      aria-haspopup="dialog"
      aria-label={`${label}: ${dialogs.account.name}`}
      onClick={event => dialogs.open(kind, event.currentTarget)}
    >
      {label}
    </Button>
  );
}

/** Usage of another strategy day: computes Today again on the server. */
export function RefreshButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button type="button" variant="secondary" size="sm" icon={<RefreshCw aria-hidden="true" />} loading={pending} loadingText="Refreshing…" onClick={() => startTransition(() => router.refresh())}>
      {label}
    </Button>
  );
}

/** All Accounts: the rest of one account's actions (focus, external loss, account values, manage). */
export function AccountRowMenu({ focusHref, manageHref }: { focusHref: string; manageHref: string }) {
  const dialogs = useStatusDialogs();
  const { account } = dialogs;
  // The menu item that opens a dialog is gone when the dialog closes: focus comes back to this button (§13.5).
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton ref={trigger} label={`More actions for ${account.name}`} icon={<Ellipsis aria-hidden="true" />} size="sm" variant="ghost" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={focusHref} prefetch={false}>
            <Filter aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Show only {account.name}</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {account.canAddExternalLoss && (
          <DropdownMenuItem icon={<Plus aria-hidden="true" />} onSelect={() => dialogs.open("loss", trigger.current)}>
            {ADD_EXTERNAL_LOSS}…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<Pencil aria-hidden="true" />} onSelect={() => dialogs.open("values", trigger.current)}>
          {UPDATE_VALUES}…
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={manageHref}>
            <Settings2 aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Manage account</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
