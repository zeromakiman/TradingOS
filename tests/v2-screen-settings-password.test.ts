import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActionState } from "@/app/actions/state";

// Settings → Security → Change password results (docs/V2_ARCHITECTURE.md §13.5: errors focused, linked and
// announced). Moving focus needs a browser; this checks what each result renders: exactly one announced alert, field
// errors linked to their inputs, and a separate summary only when it adds something to the field errors. That every
// result mounts a fresh alert (so a repeated error is announced and focused again) is covered by the result-key tests
// in v2-screen-settings-behaviour.test.ts. The form's state comes from a stubbed `useActionState`.

const m = vi.hoisted(() => ({ state: { status: "idle" } as unknown }));

vi.mock("@/app/actions/settings", () => ({ changePassword: vi.fn() }));
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useActionState: () => [m.state, () => {}, false] };
});

import { ChangePasswordForm } from "@/components/settings/change-password-form";

function render(state: ActionState): string {
  m.state = state;
  return renderToStaticMarkup(createElement(ChangePasswordForm, { email: "qa.settings@example.test" }));
}

/** Opening tags of the elements with this role. */
const withRole = (html: string, role: string) => [...html.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\brole="${role}"[^>]*>`, "g"))].map(match => match[0]);
const input = (html: string, name: string) => new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? "";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("Settings → Security → Change password: results", () => {
  it("announces nothing before the first submission", () => {
    const html = render({ status: "idle" });
    expect(withRole(html, "alert")).toEqual([]);
    expect(withRole(html, "status")).toEqual([]);
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("focuses a summary that adds to the field errors and links each field error to its input", () => {
    const html = render({ status: "error", message: "Check the highlighted fields.", fieldErrors: { confirmation: "The new passwords do not match." } });
    const alerts = withRole(html, "alert");
    expect(alerts).toHaveLength(1);
    // The summary is the focusable form alert, not a screen-reader-only repeat.
    expect(alerts[0]).toContain('tabindex="-1"');
    expect(alerts[0]).not.toContain("sr-only");
    expect(text(html)).toContain("The new passwords do not match. Check the highlighted fields.");
    const confirmation = input(html, "confirmation");
    expect(confirmation).toContain('aria-invalid="true"');
    expect(confirmation).toMatch(/aria-describedby="[^"]*\bsettings-confirmation-error\b/);
    expect(html).toContain('id="settings-confirmation-error"');
    expect(input(html, "currentPassword")).not.toContain("aria-invalid");
    expect(input(html, "newPassword")).not.toContain("aria-invalid");
  });

  it("shows a field's own error once beside the field and announces it, without a summary repeating it", () => {
    const message = "Your current password is incorrect.";
    const html = render({ status: "error", message, fieldErrors: { currentPassword: message } });
    const alerts = withRole(html, "alert");
    expect(alerts).toHaveLength(1);
    // Focus moves to the field itself; the screen-reader-only alert announces the error on every result.
    expect(alerts[0]).toContain('class="sr-only"');
    expect(alerts[0]).not.toContain("tabindex");
    expect(count(text(html), message)).toBe(2);
    const current = input(html, "currentPassword");
    expect(current).toContain('id="settings-currentPassword"');
    expect(current).toContain('aria-invalid="true"');
    expect(current).toMatch(/aria-describedby="[^"]*\bsettings-currentPassword-error\b/);
  });

  it("focuses a failure without field errors as the summary", () => {
    const message = "The password could not be changed. Nothing was changed. Please try again.";
    const html = render({ status: "error", message });
    const alerts = withRole(html, "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('tabindex="-1"');
    expect(text(html)).toContain(message);
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("confirms a change politely, with the server's words", () => {
    const html = render({ status: "success", message: "Password changed. Other devices were signed out." });
    expect(withRole(html, "alert")).toEqual([]);
    expect(withRole(html, "status")).toHaveLength(1);
    expect(text(html)).toContain("Password changed. Other devices were signed out.");
    expect(text(render({ status: "success" }))).toContain("Password changed.");
  });
});
