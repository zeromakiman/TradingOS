"use client";

import { ArchiveRestore, LockKeyhole, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import type { LockSummary } from "./model";
import { CheckRiskButton } from "./trade-actions";
import { DiscardDialog, LockPlanDialog } from "./trade-dialogs";

/**
 * The draft's own workflow next to its check (docs/V2_ARCHITECTURE.md §8.1, §14.4): Edit draft (new revision), Check
 * risk (free, persisted), Lock plan (confirmation, server re-check) and Discard. Lock stays visible but inert until the
 * latest check approves the latest revision and is still current, with the reason in words. A draft of an archived
 * account (§3.2, §9) offers only the way to restore the account and Discard: the database refuses its new revisions,
 * checks and locks.
 */

export interface DraftToolbarProps {
  tradeId: string;
  editHref: string;
  expectedRevision: number;
  checkLabel: string;
  /** Null when the plan can be locked now; otherwise why not. */
  lockBlockedReason: string | null;
  lock: LockSummary;
  discardKey: string;
  /** Manage page of the draft's account when that account is archived; omitted otherwise. */
  archivedManageHref?: string;
}

export const ARCHIVED_DRAFT_TOOLBAR_NOTE = "The account is archived: restore it to edit, check or lock this draft. Discarding stays possible.";

function DiscardButton({ tradeId, discardKey }: Pick<DraftToolbarProps, "tradeId" | "discardKey">) {
  return (
    <DiscardDialog
      tradeId={tradeId}
      requestKey={discardKey}
      trigger={
        <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden="true" />} className="sm:ml-auto">
          Discard…
        </Button>
      }
    />
  );
}

export function DraftToolbar({ tradeId, editHref, expectedRevision, checkLabel, lockBlockedReason, lock, discardKey, archivedManageHref }: DraftToolbarProps) {
  const reasonId = useId();
  if (archivedManageHref !== undefined) {
    return (
      <div className="flex flex-col gap-2" data-archived-account="true">
        <div className="flex flex-wrap items-start gap-2">
          <Link href={archivedManageHref} className={buttonClasses({ variant: "secondary", size: "sm" })}>
            <ArchiveRestore aria-hidden="true" />
            Restore in Manage
          </Link>
          <DiscardButton tradeId={tradeId} discardKey={discardKey} />
        </div>
        <p className="t-caption">{ARCHIVED_DRAFT_TOOLBAR_NOTE}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <Link href={editHref} className={buttonClasses({ variant: "secondary", size: "sm" })}>
          <Pencil aria-hidden="true" />
          Edit draft
        </Link>
        <CheckRiskButton tradeId={tradeId} label={checkLabel} size="sm" />
        {lockBlockedReason === null ? (
          <LockPlanDialog
            tradeId={tradeId}
            expectedRevision={expectedRevision}
            summary={lock}
            trigger={
              <Button size="sm" variant="secondary" icon={<LockKeyhole aria-hidden="true" />}>
                Lock plan
              </Button>
            }
          />
        ) : (
          <Button size="sm" variant="secondary" icon={<LockKeyhole aria-hidden="true" />} aria-disabled="true" aria-describedby={reasonId} onClick={event => event.preventDefault()}>
            Lock plan
          </Button>
        )}
        <DiscardButton tradeId={tradeId} discardKey={discardKey} />
      </div>
      {lockBlockedReason && (
        <p id={reasonId} className="t-caption">
          {lockBlockedReason}
        </p>
      )}
    </div>
  );
}
