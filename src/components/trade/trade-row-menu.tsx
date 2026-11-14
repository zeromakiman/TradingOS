"use client";

import { Copy, ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { IconButton } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DELETION_COPY } from "./copy";
import { TrashTradeDialog } from "./delete-dialogs";
import { DuplicateDialog } from "./trade-dialogs";

/**
 * The menu of a trade in a list (Today's cards and rows, Journal rows): Open, Duplicate as draft (planned trades with
 * a plan or draft), Delete trade. Delete trade is listed but unavailable on a locked or live trade, with the reason.
 * There is no Edit item: a trade is changed on its own page.
 */

const DUPLICATE_NOTES = [
  "Economic news is reset to “Not checked”: verify it again for the new trade.",
  "Screenshots recorded before entry are copied; live and after-close screenshots are not.",
] as const;

export interface TradeRowMenuProps {
  tradeId: string;
  href: string;
  /** "EURUSD · Long", for the menu button's name and the confirmation. */
  label: string;
  /** Locked or live: the trade must be closed, skipped or cancelled before it can be deleted. */
  open: boolean;
  /** Offer Duplicate as draft (a planned trade with a draft or a plan). */
  duplicate?: boolean;
}

export function TradeRowMenu({ tradeId, href, label, open, duplicate = false }: TradeRowMenuProps) {
  const [dialog, setDialog] = useState<"DELETE" | "DUPLICATE" | null>(null);
  // One request key per menu: a retried duplicate replays instead of creating a second draft.
  const [duplicateKey] = useState(() => (duplicate ? crypto.randomUUID() : null));
  const pending = useRef<"DELETE" | "DUPLICATE" | null>(null);
  const control = (kind: "DELETE" | "DUPLICATE") => ({
    open: dialog === kind,
    onOpenChange: (next: boolean) => setDialog(next ? kind : null),
  });
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton label={`Actions for ${label}`} icon={<MoreHorizontal aria-hidden="true" />} variant="ghost" size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-56"
          onCloseAutoFocus={event => {
            const next = pending.current;
            pending.current = null;
            if (next) {
              event.preventDefault();
              setDialog(next);
            }
          }}
        >
          <DropdownMenuItem asChild>
            <Link href={href}>
              <ExternalLink aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Open</span>
            </Link>
          </DropdownMenuItem>
          {duplicateKey && (
            <DropdownMenuItem icon={<Copy aria-hidden="true" />} onSelect={() => { pending.current = "DUPLICATE"; }}>
              Duplicate as draft…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            icon={<Trash2 aria-hidden="true" />}
            className={open ? undefined : "text-neg"}
            disabled={open}
            onSelect={() => { pending.current = "DELETE"; }}
          >
            <span className="flex min-w-0 flex-col">
              <span>{open ? "Delete trade" : "Delete trade…"}</span>
              {open && <span className="t-caption">{DELETION_COPY.trashOpenReason}</span>}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!open && <TrashTradeDialog tradeId={tradeId} label={label} {...control("DELETE")} />}
      {duplicateKey && <DuplicateDialog tradeId={tradeId} requestKey={duplicateKey} notes={DUPLICATE_NOTES} {...control("DUPLICATE")} />}
    </>
  );
}
