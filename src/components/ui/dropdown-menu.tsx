"use client";

import { Check } from "lucide-react";
import { DropdownMenu as RadixMenu } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { slotChildren } from "./slot";

/** Menu button (Radix): arrow keys, typeahead, Escape to close, focus returns to the trigger. */
export const DropdownMenu = RadixMenu.Root;

/** Opens the menu; with `asChild` a server-rendered element (lazy RSC chunk) is resolved first (./slot.ts). */
export function DropdownMenuTrigger({ asChild, children, ...props }: ComponentProps<typeof RadixMenu.Trigger>) {
  return (
    <RadixMenu.Trigger asChild={asChild} {...props}>
      {slotChildren(asChild, children)}
    </RadixMenu.Trigger>
  );
}
export const DropdownMenuGroup = RadixMenu.Group;
export const DropdownMenuRadioGroup = RadixMenu.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, align = "start", collisionPadding = 8, ...props }: ComponentProps<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content className={cx("menu", className)} sideOffset={sideOffset} align={align} collisionPadding={collisionPadding} {...props} />
    </RadixMenu.Portal>
  );
}

export type DropdownMenuItemProps = ComponentProps<typeof RadixMenu.Item> & {
  icon?: ReactNode;
  /** Secondary text aligned to the end, for example a shortcut or a currency. */
  detail?: ReactNode;
};

export function DropdownMenuItem({ className, icon, detail, children, asChild, ...props }: DropdownMenuItemProps) {
  if (asChild) {
    return (
      <RadixMenu.Item className={cx("menu-item", className)} asChild {...props}>
        {slotChildren(true, children)}
      </RadixMenu.Item>
    );
  }
  return (
    <RadixMenu.Item className={cx("menu-item", className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {detail && <span className="menu-item-detail">{detail}</span>}
    </RadixMenu.Item>
  );
}

/** Check mark shown on the selected radio item; place it inside custom `asChild` items. */
export function DropdownMenuItemIndicator() {
  return (
    <RadixMenu.ItemIndicator className="menu-item-indicator">
      <Check aria-hidden="true" />
    </RadixMenu.ItemIndicator>
  );
}

export function DropdownMenuRadioItem({ className, children, asChild, ...props }: ComponentProps<typeof RadixMenu.RadioItem>) {
  if (asChild) {
    return (
      <RadixMenu.RadioItem className={cx("menu-item", className)} asChild {...props}>
        {slotChildren(true, children)}
      </RadixMenu.RadioItem>
    );
  }
  return (
    <RadixMenu.RadioItem className={cx("menu-item", className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenuItemIndicator />
    </RadixMenu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof RadixMenu.Label>) {
  return <RadixMenu.Label className={cx("menu-label", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cx("menu-separator", className)} {...props} />;
}
