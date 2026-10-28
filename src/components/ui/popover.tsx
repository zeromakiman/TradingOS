"use client";

import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx";
import { slotChildren } from "./slot";

/** Non-modal popover (Radix): Escape and outside clicks close it, focus returns to the trigger. */
export const Popover = RadixPopover.Root;

/** Opens the popover; with `asChild` a server-rendered element (lazy RSC chunk) is resolved first (./slot.ts). */
export function PopoverTrigger({ asChild, children, ...props }: ComponentProps<typeof RadixPopover.Trigger>) {
  return (
    <RadixPopover.Trigger asChild={asChild} {...props}>
      {slotChildren(asChild, children)}
    </RadixPopover.Trigger>
  );
}

/** Closes the popover; `asChild` children are resolved like PopoverTrigger's. */
export function PopoverClose({ asChild, children, ...props }: ComponentProps<typeof RadixPopover.Close>) {
  return (
    <RadixPopover.Close asChild={asChild} {...props}>
      {slotChildren(asChild, children)}
    </RadixPopover.Close>
  );
}

export function PopoverContent({ className, sideOffset = 6, align = "center", collisionPadding = 8, ...props }: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content className={cx("popover", className)} sideOffset={sideOffset} align={align} collisionPadding={collisionPadding} {...props} />
    </RadixPopover.Portal>
  );
}
