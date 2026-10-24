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

const LAZY = Symbol.for("react.lazy");
type LazyNode = { $$typeof: symbol; _payload: unknown; _init: (payload: unknown) => unknown };

function isLazy(node: unknown): node is LazyNode {
  return typeof node === "object" && node !== null && (node as LazyNode).$$typeof === LAZY && typeof (node as LazyNode)._init === "function";
}

/**
 * A trigger created by a server component can reach this client component as an outlined (lazy) RSC chunk on long
 * pages (possibly wrapped in a one-item array), which Radix `asChild` cannot slot onto. Resolve it the way React renders
 * a lazy node (suspending while the chunk loads) so the trigger is always the element itself.
 */
export function resolveTrigger(node: ReactElement): ReactElement {
  let current: unknown = node;
  for (;;) {
    if (Array.isArray(current) && current.length === 1) current = current[0];
    else if (isLazy(current)) current = current._init(current._payload);
    else return current as ReactElement;
  }
}

/** Accessible tooltip (Radix): opens on hover and keyboard focus, closes on Escape. */
export function Tooltip({ content, children, side = "top", align = "center", delayDuration = 300 }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{resolveTrigger(children)}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="tooltip" side={side} align={align} sideOffset={6} collisionPadding={8}>
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
