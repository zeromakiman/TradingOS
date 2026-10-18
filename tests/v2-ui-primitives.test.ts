import { redirect } from "next/navigation";
import { type ComponentType, createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfirmAction, settleAction } from "@/components/ui/action-result";
import { Badge, StatusPill, type StatusTone } from "@/components/ui/badge";
import { Button, buttonClasses, IconButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, ChoiceChips, RadioCards, SegmentedControl, Switch } from "@/components/ui/choice";
import { normalizeDecimalInput } from "@/components/ui/decimal";
import { DecimalInput } from "@/components/ui/decimal-input";
import { CONFIRM_FAILED_MESSAGE, Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { FilterChips } from "@/components/ui/filter-chips";
import { Input, Select } from "@/components/ui/input";
import { Kbd, KbdCombo } from "@/components/ui/kbd";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { LoadingState, Refetching, Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Stepper } from "@/components/ui/stepper";
import { DataTable } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DeveloperModeProvider, TechnicalDetails } from "@/components/ui/technical-details";
import { ToastProvider } from "@/components/ui/toast";
import { createToastTimers, MAX_VISIBLE_TOASTS, PAUSED_RECHECK_MS, pushToast, removeToast, type ToastStack } from "@/components/ui/toast-stack";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** Creates an element whose props include required children (typed, unlike createElement's rest children). */
const element = <P extends object>(component: ComponentType<P>, props: P) => createElement(component, props);
const view = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(element(component, props));

describe("Button", () => {
  it("renders the label directly inside a native button with variant and size classes", () => {
    const markup = html(createElement(Button, { variant: "secondary", size: "sm" }, "Recheck risk"));
    expect(markup).toBe('<button class="btn btn-secondary btn-sm">Recheck risk</button>');
  });

  it("marks the loading state busy, disables the button and shows the loading label with a spinner", () => {
    const markup = html(createElement(Button, { loading: true, loadingText: "Saving…" }, "Save draft"));
    expect(markup).toMatch(/^<button[^>]*disabled=""[^>]*aria-busy="true"/);
    expect(markup).toContain("Saving…");
    expect(markup).not.toContain("Save draft");
    expect(markup).toMatch(/<svg[^>]*class="[^"]*spin[^"]*"[^>]*aria-hidden="true"/);
  });

  it("keeps V1 variant names working while their screens are rebuilt", () => {
    expect(buttonClasses({ variant: "outline" })).toBe("btn btn-secondary");
    expect(buttonClasses({ variant: "default" })).toBe("btn btn-primary");
  });

  it("styles a child link with asChild and exposes icon buttons by their label", () => {
    const link = html(createElement(Button, { asChild: true, variant: "ghost" }, createElement("a", { href: "/today" }, "Today")));
    expect(link).toBe('<a href="/today" class="btn btn-ghost">Today</a>');
    const icon = html(createElement(IconButton, { label: "Close", icon: createElement("svg") }));
    expect(icon).toContain('aria-label="Close"');
    expect(icon).toContain("btn-icon");
  });
});

describe("StatusPill and Badge", () => {
  const tones: StatusTone[] = ["neutral", "positive", "positive-muted", "negative", "danger", "warning", "info", "live", "muted"];

  it.each(tones)("renders tone %s with words, not colour alone", (tone) => {
    const markup = view(StatusPill, { tone, children: "Locked · waiting for entry" });
    expect(markup).toContain(`data-tone="${tone}"`);
    expect(markup).toContain("Locked · waiting for entry");
    expect(markup).toMatch(/class="pill pill-[a-z-]+"/);
  });

  it("maps danger onto the negative style and gives live a (reduced-motion aware) dot", () => {
    expect(view(StatusPill, { tone: "danger", children: "Blocked" })).toContain("pill-negative");
    expect(view(StatusPill, { tone: "live", children: "Live" })).toContain('<span class="pill-dot" aria-hidden="true"></span>');
    expect(view(StatusPill, { tone: "neutral", children: "Draft" })).not.toContain("pill-dot");
  });

  it("renders origin badges", () => {
    expect(html(createElement(Badge, null, "Live-first"))).toBe('<span class="badge">Live-first</span>');
  });
});

describe("Field", () => {
  it("links label, hint and error to the control and marks it invalid and required", () => {
    const markup = view(Field, {
      id: "entry",
      label: "Entry price",
      hint: "Tick size 0.00001",
      error: "Entry price must be a positive number with up to 8 decimals.",
      required: true,
      children: createElement(DecimalInput, { name: "entry", defaultValue: "1.10000" }),
    });
    expect(markup).toContain('<label for="entry" class="field-label">');
    expect(markup).toContain('id="entry"');
    expect(markup).toContain('aria-describedby="entry-hint entry-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-required="true"');
    expect(markup).toContain('<p id="entry-hint" class="field-hint">Tick size 0.00001</p>');
    expect(markup).toMatch(/<p id="entry-error" class="field-error">.*Entry price must be a positive number/);
  });

  it("omits error wiring when the field is valid and keeps the control's own description ids", () => {
    const markup = view(Field, { id: "risk", label: "Risk per trade", hint: "Maximum 0.75%", children: createElement(Input, { "aria-describedby": "risk-policy" }) });
    expect(markup).toContain('aria-describedby="risk-policy risk-hint"');
    expect(markup).not.toContain("aria-invalid");
    expect(markup).not.toContain("field-error");
  });

  it("supports a render function for custom controls", () => {
    const markup = view(Field, {
      id: "instrument",
      label: "Instrument",
      error: "Choose an instrument.",
      children: (control) => createElement(Select, { ...control, name: "instrument" }, createElement("option", null, "EURUSD")),
    });
    expect(markup).toContain('<select class="input" id="instrument" aria-describedby="instrument-error" aria-invalid="true" name="instrument">');
  });
});

describe("DecimalInput", () => {
  it("keeps the exact decimal string and asks for a decimal keypad", () => {
    for (const value of ["1.10000", "0.00001000", "0.50", "12345678901234567890.12345678"]) {
      const markup = html(createElement(DecimalInput, { name: "price", defaultValue: value }));
      expect(markup).toContain(`value="${value}"`);
      expect(markup).toContain('inputMode="decimal"');
      expect(markup).toContain('type="text"');
    }
  });

  it("normalises only whitespace and a decimal comma, never digits or scale", () => {
    expect(normalizeDecimalInput("1,10000")).toBe("1.10000");
    expect(normalizeDecimalInput("0,5")).toBe("0.5");
    expect(normalizeDecimalInput("-0,0002")).toBe("-0.0002");
    expect(normalizeDecimalInput("1 234,56")).toBe("1234.56");
    expect(normalizeDecimalInput(" 0.50 ")).toBe("0.50");
    expect(normalizeDecimalInput("0.00001000")).toBe("0.00001000");
    expect(normalizeDecimalInput("-0.0002")).toBe("-0.0002");
  });

  it("never turns a possible thousands separator into a decimal point", () => {
    // "2,350" may mean 2350: converting it would store a price a thousand times smaller.
    for (const grouped of ["10,000", "2,350", "1,250", "-1,250", "1,250,000", "25,000.50", "1,2,3"]) {
      expect(normalizeDecimalInput(grouped)).toBe(grouped);
    }
    // Typed one character at a time, the text ends ambiguous, so its value stays invalid.
    expect(["2", "2,", "2,3", "2,35", "2,350"].map(normalizeDecimalInput)).toEqual(["2", "2.", "2.3", "2.35", "2,350"]);
  });

  it("shows the text as typed and submits the normalised value under the field's name", () => {
    const markup = html(createElement(DecimalInput, { name: "entry", defaultValue: "1,10000", id: "entry" }));
    const visible = /<input type="text"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(visible).toContain('inputMode="decimal"');
    expect(visible).toContain('id="entry"');
    expect(visible).toContain('value="1,10000"');
    expect(visible).not.toContain("name=");
    expect(markup).toContain('<input type="hidden" name="entry" value="1.10000"/>');
    expect(markup.match(/name="entry"/g)).toHaveLength(1);
    expect(html(createElement(DecimalInput, { defaultValue: "0.5" }))).not.toContain('type="hidden"');
    // A disabled field submits nothing, like a native input.
    expect(html(createElement(DecimalInput, { name: "risk", defaultValue: "0.5", disabled: true }))).toMatch(/<input type="hidden"(?=[^>]*disabled="")(?=[^>]*name="risk")[^>]*value="0.5"\/>/);
  });
});

describe("Toast stack", () => {
  type Item = { id: number; duration: number | null };
  const timed = (id: number): Item => ({ id, duration: 6000 });
  const persistent = (id: number): Item => ({ id, duration: null });
  const ids = (toasts: Item[]) => toasts.map((toast) => toast.id);
  const push = (toasts: Item[]) => toasts.reduce<ToastStack<Item>>((stack, toast) => pushToast(stack, toast), { visible: [], queued: [] });

  it("keeps an error until it is dismissed while later confirmations replace each other", () => {
    const stack = push([persistent(1), timed(2), timed(3), timed(4), timed(5), timed(6)]);
    expect(MAX_VISIBLE_TOASTS).toBe(4);
    expect(ids(stack.visible)).toEqual([1, 4, 5, 6]);
    expect(stack.queued).toEqual([]);
  });

  it("queues new toasts while every visible toast stays until dismissed, then shows them in order", () => {
    let stack = push([persistent(1), persistent(2), persistent(3), persistent(4), timed(5), persistent(6)]);
    expect(ids(stack.visible)).toEqual([1, 2, 3, 4]);
    expect(ids(stack.queued)).toEqual([5, 6]);
    stack = removeToast(stack, 2);
    expect(ids(stack.visible)).toEqual([1, 3, 4, 5]);
    expect(ids(stack.queued)).toEqual([6]);
    // Later arrivals wait their turn; the timed toast leaves when its time is up.
    stack = pushToast(stack, timed(7));
    expect(ids(stack.visible)).toEqual([1, 3, 4, 5]);
    expect(ids(stack.queued)).toEqual([6, 7]);
    stack = removeToast(stack, 5);
    expect(ids(stack.visible)).toEqual([1, 3, 4, 6]);
    expect(ids(stack.queued)).toEqual([7]);
    stack = removeToast(stack, 1);
    expect(ids(stack.visible)).toEqual([3, 4, 6, 7]);
    expect(stack.queued).toEqual([]);
  });
});

describe("Toast timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const expired: number[] = [];
    const pointer = { inside: false };
    const timers = createToastTimers({ expire: (id) => expired.push(id), isPaused: () => pointer.inside });
    return { expired, pointer, timers };
  };

  it("hides a timed toast when its time is up and keeps one that stays until dismissed", () => {
    const { expired, timers } = setup();
    timers.sync([
      { id: 1, duration: 6000 },
      { id: 2, duration: null },
    ]);
    vi.advanceTimersByTime(5999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
    vi.advanceTimersByTime(60_000);
    expect(expired).toEqual([1]);
  });

  it("counts from when a toast appears and does not restart on later updates", () => {
    const { expired, timers } = setup();
    timers.sync([{ id: 1, duration: 6000 }]);
    vi.advanceTimersByTime(4000);
    timers.sync([
      { id: 1, duration: 6000 },
      { id: 2, duration: 6000 },
    ]);
    vi.advanceTimersByTime(2000);
    expect(expired).toEqual([1]);
    vi.advanceTimersByTime(4000);
    expect(expired).toEqual([1, 2]);
  });

  it("waits while the pointer or focus is in the stack, checking again every second", () => {
    const { expired, pointer, timers } = setup();
    timers.sync([{ id: 1, duration: 6000 }]);
    pointer.inside = true;
    vi.advanceTimersByTime(6000 + 3 * PAUSED_RECHECK_MS);
    expect(expired).toEqual([]);
    pointer.inside = false;
    vi.advanceTimersByTime(PAUSED_RECHECK_MS);
    expect(expired).toEqual([1]);
  });

  it("starts a queued toast's countdown only once it is visible", () => {
    const { expired, timers } = setup();
    type Item = { id: number; duration: number | null };
    let stack: ToastStack<Item> = { visible: [], queued: [] };
    for (const toast of [1, 2, 3, 4].map((id) => ({ id, duration: null }))) stack = pushToast(stack, toast);
    stack = pushToast(stack, { id: 5, duration: 6000 });
    timers.sync(stack.visible);
    vi.advanceTimersByTime(10_000);
    expect(expired).toEqual([]);
    stack = removeToast(stack, 1);
    timers.sync(stack.visible);
    vi.advanceTimersByTime(5999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([5]);
  });

  it("stops the countdown of a dismissed toast, and every countdown on dispose", () => {
    const { expired, timers } = setup();
    timers.sync([
      { id: 1, duration: 6000 },
      { id: 2, duration: 8000 },
    ]);
    timers.sync([{ id: 2, duration: 8000 }]);
    vi.advanceTimersByTime(7000);
    expect(expired).toEqual([]);
    timers.dispose();
    vi.advanceTimersByTime(60_000);
    expect(expired).toEqual([]);
  });
});

describe("Action results", () => {
  /** The error Next.js throws for redirect(), as an action that redirects rejects with on the client. */
  const redirectError = (): unknown => {
    try {
      redirect("/login?reason=signed_out");
    } catch (error) {
      return error;
    }
  };
  const networkError = () => Promise.reject(new TypeError("Failed to fetch"));

  it("treats success and idle states as done, and an error state or a thrown error as a failure", async () => {
    await expect(settleAction(async () => ({ status: "success", message: "Saved." }))).resolves.toEqual({ ok: true });
    await expect(settleAction(async () => ({ status: "idle" }))).resolves.toEqual({ ok: true });
    await expect(settleAction(async () => undefined)).resolves.toEqual({ ok: true });
    await expect(settleAction(async () => ({ status: "error", message: "Choose light, dark or system." }))).resolves.toEqual({ ok: false, message: "Choose light, dark or system." });
    await expect(settleAction(async () => ({ status: "error", message: "  " }))).resolves.toEqual({ ok: false, message: null });
    await expect(settleAction(networkError)).resolves.toEqual({ ok: false, message: null });
    await expect(
      settleAction(() => {
        throw new Error("Server exception");
      }),
    ).resolves.toEqual({ ok: false, message: null });
  });

  it("lets Next.js handle a redirect instead of reporting it as a failure", async () => {
    const error = redirectError();
    expect(error).toBeInstanceOf(Error);
    await expect(settleAction(() => Promise.reject(error))).rejects.toBe(error);
    await expect(runConfirmAction(() => Promise.reject(error), CONFIRM_FAILED_MESSAGE)).rejects.toBe(error);
  });

  it("closes a confirmation only when its action went through", async () => {
    await expect(runConfirmAction(async () => undefined, CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: true });
    await expect(runConfirmAction(() => ({ status: "success", data: { tradeId: "t1" } }), CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: true });
    // `false` keeps it open: the caller shows its own feedback.
    await expect(runConfirmAction(() => false, CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: false, error: null });
    await expect(runConfirmAction(async () => false, CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: false, error: null });
    // An action error state stays in the dialog with the action's own words.
    const changed = "This draft changed in another tab. Reload to see revision 3.";
    await expect(runConfirmAction(async () => ({ status: "error", message: changed }), CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: false, error: changed });
    await expect(runConfirmAction(async () => ({ status: "error", message: "" }), CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: false, error: CONFIRM_FAILED_MESSAGE });
    // A dropped connection or server exception keeps the dialog open instead of reaching an error boundary.
    await expect(runConfirmAction(networkError, CONFIRM_FAILED_MESSAGE)).resolves.toEqual({ close: false, error: CONFIRM_FAILED_MESSAGE });
    await expect(
      runConfirmAction(() => {
        throw new Error("Server exception");
      }, "Deletion did not finish."),
    ).resolves.toEqual({ close: false, error: "Deletion did not finish." });
  });
});

describe("TechnicalDetails", () => {
  const ids = "Proposal 5b0c8a52-6f0e-4c7a-9b0e-3f6f2d1c9a10 · RISK_LIMIT";

  it("is collapsed by default but keeps its content in the server HTML", () => {
    const markup = view(TechnicalDetails, { children: ids });
    expect(markup).toContain("<details");
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain(ids);
    expect(markup).toContain("Technical details");
  });

  it("opens by default in developer mode, from the prop or from the provider", () => {
    expect(view(TechnicalDetails, { developerMode: true, children: ids })).toMatch(/<details[^>]*open=""/);
    expect(view(DeveloperModeProvider, { value: true, children: element(TechnicalDetails, { children: ids }) })).toMatch(/<details[^>]*open=""/);
    expect(view(DeveloperModeProvider, { value: true, children: element(TechnicalDetails, { developerMode: false, children: ids }) })).not.toMatch(/<details[^>]*\sopen/);
  });

  it("uses a native disclosure for generic content too", () => {
    expect(view(Disclosure, { summary: "Calculation definitions", children: "Expectancy is the mean R." })).toContain("Expectancy is the mean R.");
  });
});

describe("Choices", () => {
  it("renders checkbox and switch with a linked description", () => {
    const checkbox = html(createElement(Checkbox, { id: "contract", name: "contract", label: "Contract values match my broker", description: "EURUSD · tick 0.00001 · $1.00 per tick" }));
    expect(checkbox).toContain('aria-describedby="contract-description"');
    expect(checkbox).toContain('<p id="contract-description"');
    const toggle = html(createElement(Switch, { id: "dev", label: "Show technical details expanded" }));
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('type="checkbox"');
  });

  it("builds radio groups inside a labelled fieldset", () => {
    const options = [
      { value: "LONG", label: "Long" },
      { value: "SHORT", label: "Short" },
    ];
    const segmented = html(createElement(SegmentedControl, { name: "direction", legend: "Direction", options, defaultValue: "LONG" }));
    expect(segmented).toContain("<fieldset");
    expect(segmented).toContain('<legend class="choice-legend sr-only">Direction</legend>');
    expect(segmented).toMatch(/<input type="radio" name="direction" checked="" value="LONG"\/>/);
    expect(segmented).toMatch(/<input type="radio" name="direction" value="SHORT"\/>/);
    const cards = html(createElement(RadioCards, { name: "model", legend: "Model", options: [{ value: "OTE", label: "OTE", description: "Optimal trade entry" }] }));
    expect(cards).toContain("radio-card-description");
    const chips = html(createElement(ChoiceChips, { name: "risk", legend: "Risk per trade", options: [{ value: "0.50", label: "0.50%" }], defaultValue: "0.50" }));
    expect(chips).toContain("chip-toggle");
    expect(chips).toMatch(/<input class="sr-only" type="radio" name="risk" checked="" value="0.50"\/>/);
  });
});

describe("Tabs, Dialog and Toast", () => {
  it("renders Radix tabs with tablist/tab/tabpanel semantics", () => {
    const markup = html(
      createElement(
        Tabs,
        { defaultValue: "weekly" },
        createElement(TabsList, { "aria-label": "Review" }, createElement(TabsTrigger, { value: "weekly" }, "Weekly"), createElement(TabsTrigger, { value: "monthly" }, "Monthly")),
        createElement(TabsContent, { value: "weekly" }, "Week of Oct 6"),
      ),
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"/);
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="false"/);
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain("aria-controls=");
  });

  it("gives dialog triggers dialog popup semantics", () => {
    const markup = html(createElement(Dialog, null, createElement(DialogTrigger, null, "Lock plan")));
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("mounts a polite live region for toasts before any toast exists", () => {
    const markup = view(ToastProvider, { children: createElement("p", null, "Body") });
    expect(markup).toContain('aria-label="Notifications"');
    expect(markup).toMatch(/<ol aria-live="polite"/);
  });
});

describe("Keyboard helpers", () => {
  it("submits the surrounding form on Ctrl/⌘+Enter only, never while composing text", () => {
    const calls = { submitted: 0, prevented: 0 };
    const form = { requestSubmit: () => calls.submitted++ };
    const press = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean }, isComposing = false) =>
      ({
        key,
        ctrlKey: false,
        metaKey: false,
        ...modifiers,
        nativeEvent: { isComposing },
        currentTarget: { closest: () => form },
        preventDefault: () => calls.prevented++,
      }) as unknown as KeyboardEvent<HTMLElement>;
    submitOnModifierEnter(press("Enter", { ctrlKey: true }));
    submitOnModifierEnter(press("Enter", { metaKey: true }));
    submitOnModifierEnter(press("Enter", {}));
    submitOnModifierEnter(press("Enter", { ctrlKey: true }, true));
    submitOnModifierEnter(press("k", { ctrlKey: true }));
    expect(calls).toEqual({ submitted: 2, prevented: 2 });
  });
});

describe("States and structure", () => {
  it("renders empty, error and loading states with guidance", () => {
    const empty = html(createElement(EmptyState, { title: "No closed trades yet.", description: "Record or plan a trade; results appear here after you close it." }));
    expect(empty).toContain("No closed trades yet.");
    expect(empty).toContain("results appear here after you close it");
    const error = html(createElement(ErrorState, { retry: createElement(Button, null, "Try again") }));
    expect(error).toContain('role="alert"');
    expect(error).toContain('href="/today"');
    expect(error).toContain("Try again");
    const loading = view(LoadingState, { label: "Loading trades", children: createElement(Skeleton, { width: "12rem" }) });
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading trades");
    expect(loading).toContain('aria-hidden="true"');
    expect(view(Refetching, { pending: true, children: "Previous render" })).toContain('aria-busy="true"');
  });

  it("marks the current stepper step and announces completed steps", () => {
    const steps = ["Draft", "Validated", "Locked", "Live", "Closed", "Reviewed"].map((label) => ({ id: label.toLowerCase(), label }));
    const markup = html(createElement(Stepper, { steps, current: "locked", label: "Trade progress" }));
    expect(markup).toContain('aria-label="Trade progress"');
    expect(markup).toMatch(/data-status="current" aria-current="step"/);
    expect(markup.match(/data-status="complete"/g)).toHaveLength(2);
    expect(markup.match(/\(completed\)/g)).toHaveLength(2);
  });

  it("renders keyset pagination with a disabled newer link on the first page", () => {
    const markup = html(createElement(Pagination, { next: { href: "/journal?cursor=abc" }, summary: "Page 1 · 50 per page" }));
    expect(markup).toContain('aria-label="Pagination"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('href="/journal?cursor=abc"');
    expect(markup).toContain('rel="next"');
  });

  it("renders removable filter chips with explicit names", () => {
    const markup = html(createElement(FilterChips, { chips: [{ key: "model", label: "Model: OTE", removeHref: "/journal" }, { key: "result", label: "Result: Win", removeHref: "/journal?model=OTE" }], clearHref: "/journal" }));
    expect(markup).toContain('aria-label="Remove filter: Model: OTE"');
    expect(markup).toContain("Clear all");
    expect(html(createElement(FilterChips, { chips: [] }))).toBe("");
  });

  it("turns table rows into labelled cards on small screens", () => {
    const markup = html(
      createElement(DataTable<{ id: string; account: string; result: string }>, {
        caption: "Accounts",
        cards: true,
        rows: [{ id: "a", account: "FTMO 100K", result: "+$120.00" }],
        rowKey: (row) => row.id,
        columns: [
          { key: "account", header: "Account", cell: (row) => row.account },
          { key: "result", header: "Today", align: "end", cell: (row) => row.result },
        ],
      }),
    );
    expect(markup).toContain("ui-table-cards");
    expect(markup).toContain('<caption class="ui-table-caption sr-only">Accounts</caption>');
    expect(markup).toContain('data-label="Today"');
    expect(markup).toContain('data-primary="true"');
  });

  it("renders callouts, stats, cards, keys and a single page heading", () => {
    expect(html(createElement(Callout, { tone: "negative", title: "Blocked", role: "alert" }, "Requested risk 0.504% exceeds your configured maximum of 0.50%."))).toMatch(/role="alert".*Blocked.*0\.504%/);
    const stat = html(createElement(Stat, { label: "Win rate", value: "66.67%", early: true, hint: "3 completed trades" }));
    expect(stat).toContain("Early");
    expect(stat).toContain("stat-early");
    const card = html(createElement(Card, { as: "section", "aria-labelledby": "t" }, createElement(CardHeader, null, createElement(CardTitle, { id: "t" }, "Live trades")), createElement(CardBody, null, "…")));
    expect(card).toMatch(/^<section class="card" aria-labelledby="t">/);
    expect(html(createElement(Kbd, null, "K"))).toBe('<kbd class="kbd">K</kbd>');
    expect(html(createElement(KbdCombo, { keys: ["Ctrl", "K"], label: "Control K" }))).toContain('<span class="sr-only">Control K</span>');
    const header = html(createElement(PageHeader, { title: "Today", description: "Wednesday, October 14" }));
    expect(header.match(/<h1/g)).toHaveLength(1);
  });
});
