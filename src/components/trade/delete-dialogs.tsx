"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";
import { deleteTradePermanently, restoreTrade, trashTrade } from "@/app/actions/trades";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useNotify } from "./action-message";
import { DELETE_TRADE_WORD, DELETION_COPY } from "./copy";
import { callTradeAction, formOf } from "./use-trade-action";

/**
 * Deleted trades (0020): move a trade to Deleted trades, restore it, delete it permanently. Shared by the trade page's
 * overflow menu, the Journal rows, Today's trade menus and the Deleted trades list. Each works with its own trigger or
 * controlled from a menu (`open`/`onOpenChange`); a refusal keeps the dialog open with the action's own words.
 */

interface Control {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirmed?: () => void;
  /** Where to go after success; the current page refreshes when omitted. */
  redirectTo?: string;
}

export function TrashTradeDialog({ tradeId, label, onConfirmed, redirectTo, ...control }: Control & { tradeId: string; label?: string }) {
  const notify = useNotify();
  const router = useRouter();
  const confirm = async () => {
    const result = await callTradeAction(trashTrade, formOf({ tradeId }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      tone="danger"
      title={DELETION_COPY.trashTitle}
      description={DELETION_COPY.trashBody}
      confirmLabel="Delete trade"
      pendingLabel="Deleting…"
      onConfirm={confirm}
    >
      {label ? <p className="t-body font-medium text-text">{label}</p> : null}
    </ConfirmDialog>
  );
}

export function PermanentDeleteDialog({ tradeId, label, onConfirmed, redirectTo, ...control }: Control & { tradeId: string; label?: string }) {
  const notify = useNotify();
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const confirm = async () => {
    const result = await callTradeAction(deleteTradePermanently, formOf({ tradeId, confirm: typed.trim() }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      setTyped("");
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      onOpenChange={open => {
        if (!open) setTyped("");
        control.onOpenChange?.(open);
      }}
      tone="danger"
      title={DELETION_COPY.permanentTitle}
      description={DELETION_COPY.permanentBody}
      confirmLabel="Delete permanently"
      pendingLabel="Deleting…"
      confirmDisabled={typed.trim() !== DELETE_TRADE_WORD}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        {label ? <p className="t-body font-medium text-text">{label}</p> : null}
        <Field label={DELETION_COPY.permanentConfirm} required>
          <Input value={typed} autoComplete="off" spellCheck={false} onChange={event => setTyped(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

export function RestoreTradeDialog({ tradeId, label, onConfirmed, redirectTo, ...control }: Control & { tradeId: string; label?: string }) {
  const notify = useNotify();
  const router = useRouter();
  const confirm = async () => {
    const result = await callTradeAction(restoreTrade, formOf({ tradeId }));
    if (result.status === "success") {
      onConfirmed?.();
      notify(result.message);
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    }
    return result;
  };
  return (
    <ConfirmDialog
      {...control}
      title="Restore this trade?"
      description="It returns to the Journal, EDGE, calendars, dashboards and Today, exactly as it was."
      confirmLabel="Restore trade"
      pendingLabel="Restoring…"
      onConfirm={confirm}
    >
      {label ? <p className="t-body font-medium text-text">{label}</p> : null}
    </ConfirmDialog>
  );
}

/** The banner on the page of a trade in Deleted trades: what that means, Restore, and Delete permanently. */
export function TrashedTradeBanner({ tradeId, trashedOn }: { tradeId: string; trashedOn: string }) {
  return (
    <Callout tone="warning" title={`In Deleted trades since ${trashedOn}`} role="status">
      <div className="flex flex-col gap-3">
        <p>{DELETION_COPY.banner}</p>
        <div className="flex flex-wrap gap-2">
          <RestoreTradeDialog tradeId={tradeId} trigger={<Button variant="secondary" icon={<RotateCcw aria-hidden="true" />}>Restore trade</Button>} />
          <PermanentDeleteDialog
            tradeId={tradeId}
            redirectTo="/trades/deleted"
            trigger={<Button variant="danger" icon={<Trash2 aria-hidden="true" />}>Delete permanently…</Button>}
          />
        </div>
      </div>
    </Callout>
  );
}

/** Restore and Delete permanently of one row of Deleted trades. */
export function DeletedTradeActions({ tradeId, label, countsToday }: { tradeId: string; label: string; countsToday: boolean }) {
  return (
    <div className="flex flex-none flex-wrap gap-2">
      <RestoreTradeDialog tradeId={tradeId} label={label} trigger={<Button variant="secondary" size="sm" icon={<RotateCcw aria-hidden="true" />}>Restore</Button>} />
      {countsToday ? (
        <Button variant="danger" size="sm" icon={<Trash2 aria-hidden="true" />} disabled title={DELETION_COPY.countsToday}>
          Delete permanently
        </Button>
      ) : (
        <PermanentDeleteDialog tradeId={tradeId} label={label} trigger={<Button variant="danger" size="sm" icon={<Trash2 aria-hidden="true" />}>Delete permanently…</Button>} />
      )}
    </div>
  );
}
