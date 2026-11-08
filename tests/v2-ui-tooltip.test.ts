import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveTrigger, Tooltip, type TooltipProps } from "@/components/ui/tooltip";

// A server component's trigger can reach the client Tooltip as an outlined RSC chunk: a lazy node whose payload is not
// a promise. Radix Slot only unwraps promise-like payloads and threw "Primitive.button failed to slot onto its
// children" on long pages (Journal at 1280px), so the Tooltip resolves lazy nodes itself.

function lazy(value: unknown): ReactElement {
  return { $$typeof: Symbol.for("react.lazy"), _payload: { value }, _init: (payload: { value: unknown }) => payload.value } as unknown as ReactElement;
}

const trigger = createElement("button", { type: "button", className: "trigger" }, "Day definition");

describe("Tooltip trigger resolution", () => {
  it("passes elements through and unwraps (nested) lazy nodes", () => {
    expect(resolveTrigger(trigger)).toBe(trigger);
    expect(resolveTrigger(lazy(trigger))).toBe(trigger);
    expect(resolveTrigger(lazy(lazy(trigger)))).toBe(trigger);
    expect(resolveTrigger([lazy(trigger)] as unknown as ReactElement)).toBe(trigger);
  });

  it("renders a lazy server trigger as the slotted button instead of throwing", () => {
    const html = renderToStaticMarkup(createElement(Tooltip, { content: "Trading days run from 17:00 New York time." } as TooltipProps, lazy(trigger)));
    expect(html).toMatch(/^<button type="button" class="trigger"[^>]*data-state="closed"[^>]*>Day definition<\/button>$/);
  });
});
