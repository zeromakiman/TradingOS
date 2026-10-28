import { AlertDialog, Dialog as RadixDialog, DropdownMenu as RadixMenu, Popover as RadixPopover, Tabs as RadixTabs } from "radix-ui";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogTrigger, Sheet, SheetClose, SheetTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuItem, DropdownMenuItemIndicator, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverClose, PopoverTrigger } from "@/components/ui/popover";
import { resolveSlotChild, slotChildren } from "@/components/ui/slot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Server components hand their elements to the design system's client `asChild` parts (FullAnalysisSheet's
// server-rendered "View full analysis" Button inside SheetTrigger asChild, Links inside menu items). On long pages
// React outlines such an element into a separate RSC chunk: the child is a lazy node whose payload is not a promise,
// which Radix Slot cannot slot onto ("Primitive.button failed to slot onto its children"). Every asChild part resolves
// it first, as the Tooltip does (tests/v2-ui-tooltip.test.ts).

/** A lazy node as React's RSC client creates it for an outlined chunk (payload: an already resolved chunk). */
function lazy(value: unknown): ReactElement {
  return { $$typeof: Symbol.for("react.lazy"), _payload: { value }, _init: (payload: { value: unknown }) => payload.value } as unknown as ReactElement;
}

const button = createElement("button", { type: "button", className: "trigger" }, "Open");
const link = createElement("a", { href: "/journal", className: "item" }, "Journal");
const html = (element: ReactNode) => renderToStaticMarkup(element as ReactElement);

describe("slot children", () => {
  it("passes elements through and unwraps (nested) lazy nodes and one-item arrays", () => {
    expect(resolveSlotChild(button)).toBe(button);
    expect(resolveSlotChild(lazy(button))).toBe(button);
    expect(resolveSlotChild(lazy(lazy(button)))).toBe(button);
    expect(resolveSlotChild([lazy(button)] as unknown as ReactElement)).toBe(button);
  });

  it("only touches children of parts that render their child", () => {
    const node = lazy(button);
    expect(slotChildren(false, node)).toBe(node);
    expect(slotChildren(true, node)).toBe(button);
    expect(slotChildren(true, "text")).toBe("text");
  });
});

describe("asChild parts render a server-rendered (lazy) child instead of throwing", () => {
  it("Dialog and Sheet triggers and closes", () => {
    for (const [Root, Trigger, Close] of [
      [Dialog, DialogTrigger, DialogClose],
      [Sheet, SheetTrigger, SheetClose],
    ] as const) {
      const markup = html(createElement(Root, null, createElement(Trigger, { asChild: true }, lazy(button)), createElement(Close, { asChild: true }, lazy(link))));
      expect(markup).toMatch(/^<button type="button" class="trigger" aria-haspopup="dialog" aria-expanded="false"[^>]*data-state="closed">Open<\/button>/);
      expect(markup).toMatch(/<a href="\/journal" class="item"[^>]*>Journal<\/a>$/);
    }
    // Without asChild the parts render their own button around the children, as before.
    expect(html(createElement(Dialog, null, createElement(DialogTrigger, null, "Open dialog")))).toMatch(/^<button type="button" aria-haspopup="dialog"[^>]*>Open dialog<\/button>$/);
  });

  it("ConfirmDialog's trigger", () => {
    const markup = html(createElement(ConfirmDialog, { trigger: lazy(button), title: "Archive account?", confirmLabel: "Archive", onConfirm: () => undefined }));
    expect(markup).toMatch(/^<button type="button" class="trigger" aria-haspopup="dialog"[^>]*data-state="closed">Open<\/button>$/);
  });

  it("Popover trigger and close", () => {
    const markup = html(createElement(Popover, null, createElement(PopoverTrigger, { asChild: true }, lazy(button)), createElement(PopoverClose, { asChild: true }, lazy(link))));
    expect(markup).toMatch(/^<button type="button" class="trigger" aria-haspopup="dialog" aria-expanded="false"[^>]*data-state="closed">Open<\/button>/);
    expect(markup).toContain('<a href="/journal" class="item"');
  });

  it("DropdownMenu trigger, items and radio items", () => {
    const trigger = html(createElement(DropdownMenu, null, createElement(DropdownMenuTrigger, { asChild: true }, lazy(button))));
    expect(trigger).toMatch(/^<button type="button" class="trigger"[^>]*aria-haspopup="menu"[^>]*>Open<\/button>$/);
    const items = html(
      createElement(
        RadixMenu.Root,
        { open: true },
        createElement(
          RadixMenu.Content,
          null,
          createElement(DropdownMenuItem, { asChild: true }, lazy(link)),
          createElement(
            DropdownMenuRadioGroup,
            { value: "all" },
            createElement(DropdownMenuRadioItem, { value: "all", asChild: true }, lazy(createElement("a", { href: "/today?account=all" }, "All Accounts", createElement(DropdownMenuItemIndicator)))),
          ),
        ),
      ),
    );
    expect(items).toMatch(/<a href="\/journal" class="menu-item item" role="menuitem"/);
    expect(items).toMatch(/<a href="\/today\?account=all" role="menuitemradio" aria-checked="true" class="menu-item"/);
  });

  it("Tabs triggers", () => {
    const markup = html(createElement(Tabs, { defaultValue: "weekly" }, createElement(TabsList, null, createElement(TabsTrigger, { value: "weekly", asChild: true }, lazy(createElement("button", { type: "button" }, "Weekly"))))));
    expect(markup).toMatch(/<button type="button" role="tab" aria-selected="true"[^>]*class="tab"[^>]*>Weekly<\/button>/);
  });

  it("Button asChild", () => {
    expect(html(createElement(Button, { asChild: true, variant: "secondary" }, lazy(link)))).toBe('<a href="/journal" class="btn btn-secondary item">Journal</a>');
  });

  it("matches the Radix primitives' own markup for plain children", () => {
    const ours = html(createElement(Popover, null, createElement(PopoverTrigger, { asChild: true }, button)));
    const radix = html(createElement(RadixPopover.Root, null, createElement(RadixPopover.Trigger, { asChild: true }, button)));
    expect(ours).toBe(radix);
    const dialog = html(createElement(Dialog, null, createElement(DialogTrigger, { asChild: true }, button)));
    expect(dialog).toBe(html(createElement(RadixDialog.Root, null, createElement(RadixDialog.Trigger, { asChild: true }, button))));
    const alert = html(createElement(AlertDialog.Root, null, createElement(AlertDialog.Trigger, { asChild: true }, button)));
    expect(html(createElement(ConfirmDialog, { trigger: button, title: "Sure?", confirmLabel: "Yes", onConfirm: () => undefined }))).toBe(alert);
    expect(html(createElement(Tabs, { defaultValue: "a" }, createElement(TabsList, null, createElement(TabsTrigger, { value: "a" }, "A"))))).toBe(
      html(createElement(RadixTabs.Root, { defaultValue: "a" }, createElement(RadixTabs.List, { className: "tabs-list" }, createElement(RadixTabs.Trigger, { value: "a", className: "tab" }, "A")))),
    );
  });
});
