"use client";

import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx";

/** Non-modal popover (Radix): Escape and outside clicks close it, focus returns to the trigger. */
export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

export function PopoverContent({ className, sideOffset = 6, align = "center", collisionPadding = 8, ...props }: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content className={cx("popover", className)} sideOffset={sideOffset} align={align} collisionPadding={collisionPadding} {...props} />
    </RadixPopover.Portal>
  );
}
