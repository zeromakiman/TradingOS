"use client";

import { X } from "lucide-react";
import { AlertDialog, Dialog as RadixDialog } from "radix-ui";
import { type ComponentProps, type MouseEvent, type ReactElement, type ReactNode, useState, useTransition } from "react";
import { runConfirmAction } from "./action-result";
import { Button, IconButton } from "./button";
import { Callout } from "./callout";
import { cx } from "./cx";
import { restoreFocusWhenLost } from "./focus";
import { slotChildren } from "./slot";

/** Modal dialog (Radix): traps focus, closes on Escape and restores focus to the trigger. */
export const Dialog = RadixDialog.Root;

/** Opens the dialog; with `asChild` a server-rendered element (lazy RSC chunk) is resolved first (./slot.ts). */
export function DialogTrigger({ asChild, children, ...props }: ComponentProps<typeof RadixDialog.Trigger>) {
  return (
    <RadixDialog.Trigger asChild={asChild} {...props}>
      {slotChildren(asChild, children)}
    </RadixDialog.Trigger>
  );
}

/** Closes the dialog; `asChild` children are resolved like DialogTrigger's. */
export function DialogClose({ asChild, children, ...props }: ComponentProps<typeof RadixDialog.Close>) {
  return (
    <RadixDialog.Close asChild={asChild} {...props}>
      {slotChildren(asChild, children)}
    </RadixDialog.Close>
  );
}

type DialogFrameProps = Omit<ComponentProps<typeof RadixDialog.Content>, "title"> & {
  /** Accessible name of the dialog. Required even when visually hidden. */
  title: ReactNode;
  description?: ReactNode;
  titleHidden?: boolean;
  hideCloseButton?: boolean;
};

const noDescription = { "aria-describedby": undefined };

function DialogHeading({ title, description, titleHidden, className }: { title: ReactNode; description?: ReactNode; titleHidden?: boolean; className: string }) {
  return (
    <div className={cx(className, titleHidden && "sr-only")}>
      <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
      {description && <RadixDialog.Description className="dialog-description">{description}</RadixDialog.Description>}
    </div>
  );
}

function CloseButton() {
  return (
    <RadixDialog.Close asChild>
      <IconButton label="Close" icon={<X />} size="sm" className="dialog-close" />
    </RadixDialog.Close>
  );
}

export type DialogContentProps = DialogFrameProps & { size?: "sm" | "md" | "lg" };

export function DialogContent({ title, description, titleHidden, hideCloseButton, size = "md", className, children, ...props }: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="overlay" />
      <RadixDialog.Content className={cx("dialog", size !== "md" && `dialog-${size}`, className)} {...(description ? {} : noDescription)} {...props}>
        <DialogHeading title={title} description={description} titleHidden={titleHidden} className="dialog-header" />
        <div className="dialog-body">{children}</div>
        {!hideCloseButton && <CloseButton />}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("dialog-footer", className)} {...props} />;
}

/** Side panel ("View full analysis") or bottom sheet (mobile actions); same focus handling as Dialog. */
export const Sheet = RadixDialog.Root;
/** Opens the sheet (for example FullAnalysisSheet's server-rendered "View full analysis" button). */
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;

export type SheetContentProps = DialogFrameProps & { side?: "right" | "bottom" };

export function SheetContent({ title, description, titleHidden, hideCloseButton, side = "right", className, children, ...props }: SheetContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="overlay" />
      <RadixDialog.Content className={cx("sheet", `sheet-${side}`, className)} {...(description ? {} : noDescription)} {...props}>
        <DialogHeading title={title} description={description} titleHidden={titleHidden} className="sheet-header" />
        <div className="sheet-body">{children}</div>
        {!hideCloseButton && <CloseButton />}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export type ConfirmDialogProps = {
  /** Element that opens the dialog; omit when controlling `open` from outside. */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content, for example the list of what becomes immutable after locking. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  pendingLabel?: ReactNode;
  tone?: "primary" | "danger";
  confirmDisabled?: boolean;
  /**
   * Runs the confirmed action; the dialog closes when it finishes. It stays open when the action
   * returns `false` (the caller shows its own feedback, for example a validation error), returns
   * a §12.2 error state (`{ status: "error", message }`, shown in the dialog), or throws (for
   * example when the connection drops; `errorMessage` is shown).
   */
  onConfirm: () => unknown;
  /** Shown in the dialog when `onConfirm` throws. */
  errorMessage?: string;
  /**
   * Where focus goes when the trigger is gone after a successful action, for example a "Remove" button whose row the
   * page update removes: a stable element of the same section (its heading or list). Evaluated after the update, so it
   * sees the new page. While the trigger stays, focus returns to it as usual.
   */
  returnFocus?: () => HTMLElement | null | undefined;
};

export const CONFIRM_FAILED_MESSAGE = "This could not be completed. Check your connection and try again.";

/** Confirmation (Radix AlertDialog, `role="alertdialog"`); the cancel button receives initial focus. */
export function ConfirmDialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  pendingLabel,
  tone = "primary",
  confirmDisabled = false,
  onConfirm,
  errorMessage = CONFIRM_FAILED_MESSAGE,
  returnFocus,
}: ConfirmDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isOpen = open ?? uncontrolledOpen;

  const setOpen = (next: boolean) => {
    setError(null);
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      // A failure keeps the dialog open with its message instead of reaching an error boundary.
      const outcome = await runConfirmAction(onConfirm, errorMessage);
      startTransition(() => {
        if (outcome.close) {
          setOpen(false);
          if (returnFocus) restoreFocusWhenLost(returnFocus);
        } else setError(outcome.error);
      });
    });
  };

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={(next) => !pending && setOpen(next)}>
      {trigger && <AlertDialog.Trigger asChild>{slotChildren(true, trigger)}</AlertDialog.Trigger>}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog dialog-sm" {...(description ? {} : noDescription)}>
          <div className="dialog-header">
            <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
            {description && <AlertDialog.Description className="dialog-description">{description}</AlertDialog.Description>}
          </div>
          {children && <div className="dialog-body">{children}</div>}
          {error && (
            <Callout tone="negative" role="alert" className="dialog-body">
              {error}
            </Callout>
          )}
          <div className="dialog-footer">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button variant={tone === "danger" ? "danger" : "primary"} loading={pending} loadingText={pendingLabel} disabled={confirmDisabled} onClick={confirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
