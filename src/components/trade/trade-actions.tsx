"use client";

import {
  Ban, ChevronRight, Copy, FileCode2, LockKeyhole, LogIn, LogOut, MessageSquarePlus, MoreHorizontal, NotebookPen, Pencil, RotateCcw, ShieldCheck, SquarePen,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { type MouseEvent, type ReactNode, useRef, useState } from "react";
import { checkRisk } from "@/app/actions/trades";
import { Button, type ButtonSize, buttonClasses, IconButton } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { TradeAction } from "@/domain/trade-state";
import { useNotify } from "./action-message";
import type { HeaderActionsModel, LockSummary, MenuKind } from "./model";
import { focusComposer, keepFocusOnTrade, returnFocusTo, reveal, revealTechnicalDetails, TRADE_TARGETS } from "./reveal";
import { DiscardDialog, DuplicateDialog, LockPlanDialog, ReopenReviewDialog, SkipTradeDialog } from "./trade-dialogs";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Actions of the trade page (docs/V2_ARCHITECTURE.md §2.4, §14.4): one primary next action per state, a few visible
 * secondary actions and the overflow menu (Duplicate draft, Discard, Skip, Reopen review, Technical details). Actions
 * that continue elsewhere on the page (record the entry, close, review, write in the journal) are in-page links that
 * scroll to their form and focus its first field; the rest run their §12.2 action, through a confirmation when they
 * change history.
 */

export interface TradeActionContext {
  tradeId: string;
  /** `/trades/<id>/edit`. */
  editHref: string;
  /** Latest draft revision (Lock plan's `expectedRevision`); null outside drafts. */
  expectedRevision: number | null;
  lock: LockSummary | null;
  keys: { duplicate: string; discard: string; reopen: string };
  /** What duplicating copies, in words (`duplicateNotes`). */
  duplicateNotes: readonly string[];
  /** The skip confirmation's note on the trading day the plan counts toward (`skipSlotNote`). */
  skipNote: string;
}

type Variant = "primary" | "secondary" | "ghost";

/** Runs the free deterministic check of the latest revision (`checkRisk`); the page refreshes with its result. */
export function CheckRiskButton({ tradeId, label, variant = "secondary", size = "md", className }: { tradeId: string; label: string; variant?: Variant; size?: ButtonSize; className?: string }) {
  const notify = useNotify();
  const { state, pending, run } = useTradeAction(checkRisk, result => {
    notify(result.message, result.data?.decision === "BLOCKED" ? "warning" : "positive");
    keepFocusOnTrade();
  });
  return (
    <span className={cx("inline-flex flex-col gap-1", className)}>
      <Button variant={variant} size={size} icon={<ShieldCheck aria-hidden="true" />} loading={pending} loadingText="Checking…" onClick={() => run(formOf({ tradeId }))} className="w-full">
        {label}
      </Button>
      {state.status === "error" && (
        <span role="alert" className="t-caption max-w-xs text-neg">
          {state.message}
        </span>
      )}
    </span>
  );
}

/** An in-page link styled as a button: without JavaScript it jumps to `#target`; with it, it also focuses the form. */
function JumpLink({ target, icon, children, variant, size = "md", className, onReveal = () => reveal(target) }: {
  target: string; icon: ReactNode; children: ReactNode; variant: Variant; size?: ButtonSize; className?: string; onReveal?: () => boolean;
}) {
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onReveal()) event.preventDefault();
  };
  return (
    <a href={`#${target}`} onClick={go} className={buttonClasses({ variant, size, className })}>
      {icon}
      {children}
    </a>
  );
}

/** The control for one §2.4 action. Paid AI actions render nothing here: they live in their sections with estimates. */
export function TradeActionButton({ action, context, variant = "secondary", size = "md", className }: { action: TradeAction; context: TradeActionContext; variant?: Variant; size?: ButtonSize; className?: string }) {
  const button = (icon: ReactNode) => (
    <Button variant={variant} size={size} icon={icon} className={className}>
      {action.label}
    </Button>
  );
  switch (action.kind) {
    case "CHECK_RISK":
    case "RECHECK_RISK":
      return <CheckRiskButton tradeId={context.tradeId} label={action.label} variant={variant} size={size} className={className} />;
    case "EDIT_DRAFT":
      return (
        <Link href={context.editHref} className={buttonClasses({ variant, size, className })}>
          <Pencil aria-hidden="true" />
          {action.label}
        </Link>
      );
    case "LOCK_PLAN":
      return context.expectedRevision !== null && context.lock ? (
        <LockPlanDialog tradeId={context.tradeId} expectedRevision={context.expectedRevision} summary={context.lock} trigger={button(<LockKeyhole aria-hidden="true" />)} />
      ) : null;
    case "RECORD_ENTRY":
      return <JumpLink target={TRADE_TARGETS.recordEntry} icon={<LogIn aria-hidden="true" />} variant={variant} size={size} className={className}>{action.label}</JumpLink>;
    case "ADD_JOURNAL":
      return (
        <JumpLink target={TRADE_TARGETS.journal} icon={<MessageSquarePlus aria-hidden="true" />} variant={variant} size={size} className={className} onReveal={() => focusComposer()}>
          {action.label}
        </JumpLink>
      );
    case "CLOSE_TRADE":
      return <JumpLink target={TRADE_TARGETS.closeTrade} icon={<LogOut aria-hidden="true" />} variant={variant} size={size} className={className}>{action.label}</JumpLink>;
    case "ADD_ENTRY_DETAILS":
      return <JumpLink target={TRADE_TARGETS.entryDetails} icon={<SquarePen aria-hidden="true" />} variant={variant} size={size} className={className}>{action.label}</JumpLink>;
    case "WRITE_REVIEW":
      return <JumpLink target={TRADE_TARGETS.review} icon={<NotebookPen aria-hidden="true" />} variant={variant} size={size} className={className}>{action.label}</JumpLink>;
    case "REOPEN_REVIEW":
      return <ReopenReviewDialog tradeId={context.tradeId} requestKey={context.keys.reopen} trigger={button(<RotateCcw aria-hidden="true" />)} />;
    case "SKIP":
      return <SkipTradeDialog tradeId={context.tradeId} slotNote={context.skipNote} trigger={button(<Ban aria-hidden="true" />)} />;
    case "DISCARD":
      return <DiscardDialog tradeId={context.tradeId} requestKey={context.keys.discard} trigger={button(<Trash2 aria-hidden="true" />)} />;
    default:
      return null;
  }
}

const MENU_ICONS: Readonly<Record<MenuKind, ReactNode>> = {
  EDIT_DRAFT: <Pencil aria-hidden="true" />,
  CLOSE_TRADE: <LogOut aria-hidden="true" />,
  ADD_ENTRY_DETAILS: <SquarePen aria-hidden="true" />,
  REOPEN_REVIEW: <RotateCcw aria-hidden="true" />,
  DUPLICATE: <Copy aria-hidden="true" />,
  DISCARD: <Trash2 aria-hidden="true" />,
  SKIP: <Ban aria-hidden="true" />,
  TECHNICAL: <FileCode2 aria-hidden="true" />,
};

type DialogKind = "DUPLICATE" | "DISCARD" | "SKIP" | "REOPEN_REVIEW";
const DIALOGS: ReadonlySet<MenuKind> = new Set<MenuKind>(["DUPLICATE", "DISCARD", "SKIP", "REOPEN_REVIEW"]);

/** Overflow menu; items that are buttons from the small breakpoint up are listed on phones only. */
export function TradeMenu({ model, context }: { model: HeaderActionsModel; context: TradeActionContext }) {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  // Work that waits until the menu has closed: opening a dialog, or moving focus to a form further down.
  const afterClose = useRef<{ focus: boolean; run: () => void } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Whether the open dialog's action succeeded (set just before it closes).
  const confirmed = useRef(false);
  const technical = model.menu.find(entry => entry.kind === "TECHNICAL");
  const entries = model.menu.filter(entry => entry.kind !== "TECHNICAL");
  const dialogProps = (kind: DialogKind) => ({
    open: dialog === kind,
    onOpenChange: (open: boolean) => {
      setDialog(open ? kind : null);
      if (open) return;
      // These dialogs have no trigger of their own, so Radix has nowhere to return focus when they close: a dismissed
      // dialog gives it back to the menu button. After a confirmed action the trade's new state takes focus instead.
      if (!confirmed.current) returnFocusTo(trigger.current);
      confirmed.current = false;
    },
    onConfirmed: () => {
      confirmed.current = true;
    },
  });

  const select = (kind: MenuKind) => {
    if (DIALOGS.has(kind)) {
      // Open the dialog once the menu has closed and handed focus back to its button.
      afterClose.current = {
        focus: false,
        run: () => {
          confirmed.current = false;
          setDialog(kind as DialogKind);
        },
      };
      return;
    }
    const run = kind === "CLOSE_TRADE" ? () => reveal(TRADE_TARGETS.closeTrade)
      : kind === "ADD_ENTRY_DETAILS" ? () => reveal(TRADE_TARGETS.entryDetails)
      : () => revealTechnicalDetails();
    afterClose.current = { focus: true, run: () => void run() };
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton ref={trigger} label="More actions" icon={<MoreHorizontal aria-hidden="true" />} variant="secondary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-56"
          onCloseAutoFocus={event => {
            const next = afterClose.current;
            afterClose.current = null;
            if (!next) return;
            if (next.focus) event.preventDefault();
            next.run();
          }}
        >
          {entries.map(entry =>
            entry.kind === "EDIT_DRAFT" ? (
              <DropdownMenuItem key={entry.kind} asChild className={entry.compactOnly ? "sm:hidden" : undefined}>
                <Link href={context.editHref}>
                  {MENU_ICONS.EDIT_DRAFT}
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                key={entry.kind}
                icon={MENU_ICONS[entry.kind]}
                className={cx(entry.compactOnly && "sm:hidden", entry.destructive && "text-neg")}
                onSelect={() => select(entry.kind)}
              >
                {DIALOGS.has(entry.kind) ? `${entry.label}…` : entry.label}
              </DropdownMenuItem>
            ),
          )}
          {technical && (
            <>
              {entries.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem icon={MENU_ICONS.TECHNICAL} detail={<ChevronRight aria-hidden="true" className="size-4" />} onSelect={() => select("TECHNICAL")}>
                {technical.label}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {model.menu.some(entry => entry.kind === "DUPLICATE") && (
        <DuplicateDialog tradeId={context.tradeId} requestKey={context.keys.duplicate} notes={context.duplicateNotes} {...dialogProps("DUPLICATE")} />
      )}
      {model.menu.some(entry => entry.kind === "DISCARD") && <DiscardDialog tradeId={context.tradeId} requestKey={context.keys.discard} {...dialogProps("DISCARD")} />}
      {model.menu.some(entry => entry.kind === "SKIP") && <SkipTradeDialog tradeId={context.tradeId} slotNote={context.skipNote} {...dialogProps("SKIP")} />}
      {model.menu.some(entry => entry.kind === "REOPEN_REVIEW") && <ReopenReviewDialog tradeId={context.tradeId} requestKey={context.keys.reopen} {...dialogProps("REOPEN_REVIEW")} />}
    </>
  );
}

/**
 * The header's action group. Phones: the primary action fills the row next to the menu; secondary actions move into
 * the menu. From the small breakpoint up the secondary actions are buttons. Without a primary action (a reviewed
 * trade), the first secondary action is a button on every screen.
 */
export function TradeHeaderActions({ model, context }: { model: HeaderActionsModel; context: TradeActionContext }) {
  const { primary, secondary } = model;
  return (
    <div className="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:justify-end">
      {secondary.map(action => (
        <div key={action.kind} className={primary ? "hidden sm:block" : "flex-1 sm:flex-none"}>
          <TradeActionButton action={action} context={context} variant="secondary" className={primary ? undefined : "w-full sm:w-auto"} />
        </div>
      ))}
      {primary && (
        <div className="flex-1 sm:flex-none">
          <TradeActionButton action={primary} context={context} variant="primary" className="w-full sm:w-auto" />
        </div>
      )}
      <TradeMenu model={model} context={context} />
    </div>
  );
}
