import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next/link renders only `href` into HTML; this stand-in also prints the prefetch choice it was given.
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...props }: { href: string; prefetch?: boolean | null; children?: ReactNode }) =>
    createElement("a", { ...props, href, "data-prefetch": prefetch === undefined ? "default" : String(prefetch) }, children),
}));

import { CategoryTable } from "@/components/charts/category-table";
import { buttonClasses } from "@/components/ui/button";
import { SegmentedControl, SegmentedLinks } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Input, Select } from "@/components/ui/input";
import { prefetchFor, switchesAccountContext } from "@/components/ui/links";
import { TableLink } from "@/components/ui/table";
import { TEXTAREA_TOUCH_TARGET, Textarea } from "@/components/ui/textarea";

const FTMO = "7d3c2f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

describe("links that switch the trading-account context (V2 §9.2)", () => {
  it("are recognised by their ?account= parameter, in strings and URL objects", () => {
    expect(switchesAccountContext(`/journal?model=OTE&account=${FTMO}`)).toBe(true);
    expect(switchesAccountContext("/today?account=all")).toBe(true);
    expect(switchesAccountContext({ pathname: "/edge", query: { account: FTMO } })).toBe(true);
    expect(switchesAccountContext({ pathname: "/edge", search: "?account=all" })).toBe(true);
    expect(switchesAccountContext("/journal?model=OTE")).toBe(false);
    expect(switchesAccountContext({ pathname: "/edge", query: { model: "OTE" } })).toBe(false);
    expect(switchesAccountContext("/accounts/abc")).toBe(false);
  });

  it("are never prefetched; other links keep their own choice", () => {
    expect(prefetchFor(`/journal?account=${FTMO}`, true)).toBe(false);
    expect(prefetchFor(`/journal?account=${FTMO}`, undefined)).toBe(false);
    expect(prefetchFor("/journal?model=OTE", undefined)).toBeUndefined();
    expect(prefetchFor("/journal?model=OTE", false)).toBe(false);
  });

  it("are rendered without prefetch by TableLink and the charts' tables (CategoryTable)", () => {
    expect(renderToStaticMarkup(createElement(TableLink, { href: `/journal?account=${FTMO}` }, "FTMO 100K"))).toContain('data-prefetch="false"');
    expect(renderToStaticMarkup(createElement(TableLink, { href: "/trades/abc" }, "EURUSD"))).toContain('data-prefetch="default"');
    const table = renderToStaticMarkup(
      createElement(CategoryTable, {
        caption: "Account contribution",
        categoryLabel: "Trading account",
        valueName: "Net R",
        data: [
          { key: "ftmo", label: "FTMO 100K", value: "7.1", valueLabel: "+7.10R", href: `/journal?state=closed&account=${FTMO}` },
          { key: "ote", label: "OTE", value: "2", valueLabel: "+2.00R", href: "/journal?model=OTE" },
        ],
      }),
    );
    expect(table).toMatch(/href="\/journal\?state=closed&amp;account=[^"]+" data-prefetch="false"/);
    expect(table).toMatch(/href="\/journal\?model=OTE" data-prefetch="default"/);
  });
});

describe("touch targets (V2 §13.5: at least 44px on touch screens)", () => {
  it("grows small buttons and small icon buttons on coarse pointers only, never text links", () => {
    expect(buttonClasses({ size: "sm" })).toBe("btn btn-primary btn-sm pointer-coarse:min-h-11");
    expect(buttonClasses({ size: "sm", iconOnly: true, variant: "ghost" })).toBe("btn btn-ghost btn-sm btn-icon pointer-coarse:min-h-11 pointer-coarse:w-11");
    expect(buttonClasses({ size: "sm", variant: "link" })).toBe("btn btn-link btn-sm");
    expect(buttonClasses()).toBe("btn btn-primary");
  });

  it("makes inputs, selects and decimal fields 44px tall on touch screens", () => {
    expect(renderToStaticMarkup(createElement(Input, { name: "q" }))).toBe('<input class="input pointer-coarse:min-h-11" name="q"/>');
    expect(renderToStaticMarkup(createElement(Select, { name: "model" }))).toContain('<select class="input pointer-coarse:min-h-11" name="model">');
    expect(renderToStaticMarkup(createElement(DecimalInput, { defaultValue: "1.5" }))).toContain('class="input input-numeric pointer-coarse:min-h-11"');
  });

  it("makes a one-line textarea (the journal composer) 44px tall on touch screens without lowering a taller one", () => {
    // Padding, not a minimum height: a minimum on coarse pointers would override the 88px default or a consumer's
    // `min-h-32`, while the composer's own `min-h-10` would keep it at 42px.
    expect(TEXTAREA_TOUCH_TARGET).toBe("pointer-coarse:py-[max(0.5rem,calc((2.75rem_-_1lh)/2_-_1px))]");
    expect(TEXTAREA_TOUCH_TARGET).not.toMatch(/min-h/);
    const composer = renderToStaticMarkup(createElement(Textarea, { rows: 1, className: "min-h-10 resize-none", defaultValue: "" }));
    expect(composer).toBe(`<textarea class="input ${TEXTAREA_TOUCH_TARGET} min-h-10 resize-none" rows="1"></textarea>`);
    const notes = renderToStaticMarkup(createElement(Textarea, { rows: 5, className: "min-h-32", defaultValue: "" }));
    expect(notes).toContain(`class="input ${TEXTAREA_TOUCH_TARGET} min-h-32"`);
  });

  it("makes small segmented options 44px tall on touch screens; the regular size already is", () => {
    const options = [
      { value: "now", label: "Now" },
      { value: "earlier", label: "Earlier" },
    ];
    const small = renderToStaticMarkup(createElement(SegmentedControl, { name: "time", legend: "Entry time", options, size: "sm", defaultValue: "now" }));
    expect(small.match(/class="segmented-label pointer-coarse:min-h-11"/g)).toHaveLength(2);
    const regular = renderToStaticMarkup(createElement(SegmentedControl, { name: "direction", legend: "Direction", options, defaultValue: "now" }));
    expect(regular).toContain('class="segmented-label"');
    expect(regular).not.toContain("pointer-coarse");
    const links = renderToStaticMarkup(createElement(SegmentedLinks, { label: "Calendar shows", size: "sm", items: [{ href: "/edge?mode=net-r", label: "Net R", current: true }] }));
    expect(links).toContain('class="segmented-label pointer-coarse:min-h-11"');
  });
});
