"use client";

import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

export type TooltipProps = {
  /** Supplementary text. Tooltips never carry information that is unavailable elsewhere. */
  content: ReactNode;
  /** A single focusable element (button, link) that triggers the tooltip on hover and focus. */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
};

/** Accessible tooltip (Radix): opens on hover and keyboard focus, closes on Escape. */
export function Tooltip({ content, children, side = "top", align = "center", delayDuration = 300 }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="tooltip" side={side} align={align} sideOffset={6} collisionPadding={8}>
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
