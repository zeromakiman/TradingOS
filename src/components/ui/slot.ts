import type { ReactNode } from "react";

/**
 * Children of Radix `asChild` parts (triggers, closes, menu items, `Button asChild`) as an element Radix Slot can merge
 * its props onto.
 *
 * A server component often renders the element (`<SheetTrigger asChild><Button>…</Button></SheetTrigger>`, a `<Link>`
 * inside `DropdownMenuItem asChild`). It reaches the client component as React Server Components data, and on long
 * pages React outlines it into a separate chunk: the child is then a lazy node (possibly in a one-item array) whose
 * payload is not a promise. Radix Slot only unwraps promise-like payloads and fails ("Primitive.button failed to slot
 * onto its children"). Resolving the lazy node the way React renders one (suspending while its chunk loads) always
 * hands Slot the element itself. Anything else is returned unchanged.
 */

const LAZY = Symbol.for("react.lazy");
type LazyNode = { $$typeof: symbol; _payload: unknown; _init: (payload: unknown) => unknown };

function isLazy(node: unknown): node is LazyNode {
  return typeof node === "object" && node !== null && (node as LazyNode).$$typeof === LAZY && typeof (node as LazyNode)._init === "function";
}

export function resolveSlotChild<T extends ReactNode>(node: T): T {
  let current: unknown = node;
  for (;;) {
    if (Array.isArray(current) && current.length === 1) current = current[0];
    else if (isLazy(current)) current = current._init(current._payload);
    else return current as T;
  }
}

/** `children` for a Radix part: resolved when it renders its child (`asChild`), unchanged otherwise. */
export function slotChildren<T extends ReactNode>(asChild: boolean | undefined, children: T): T {
  return asChild ? resolveSlotChild(children) : children;
}
