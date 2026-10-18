"use client";

import { Tabs as RadixTabs } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx";

/** In-page tabs (Radix): arrow keys move between tabs, panels are linked with aria-controls. */
export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cx("tabs-list", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger className={cx("tab", className)} {...props} />;
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx("tab-panel", className)} {...props} />;
}
