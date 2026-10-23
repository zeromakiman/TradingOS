import Decimal from "decimal.js";
import { stripZeros } from "@/domain/format";
import type { Lifecycle } from "@/domain/ledger";
import { buildTimeline, type JournalKind, type TimelineTrade, type Timing } from "@/domain/timeline";

/**
 * Pure rules of the live journal composer (docs/V2_ARCHITECTURE.md §3.6, §12.2): kinds and their words,
 * client validation that rejects exactly what `add_journal_entry` / `private.check_journal_details`
 * would reject (with field copy instead of a round trip), and the `addJournalEntry` form fields. The
 * database still validates everything, including tick alignment when the instrument is known.
 */

export type { JournalKind } from "@/domain/timeline";

export const JOURNAL_KINDS: readonly JournalKind[] = Object.freeze(["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"]);

/** Chip words: Note · Decision · Stop · Target · Partial · Lesson. */
export const JOURNAL_KIND_LABELS: Readonly<Record<JournalKind, string>> = Object.freeze({
  NOTE: "Note",
  DECISION: "Decision",
  STOP_CHANGE: "Stop",
  TARGET_CHANGE: "Target",
  PARTIAL_CLOSE: "Partial",
  LESSON: "Lesson",
});

/** Placeholder of the text field per kind; the note's is the exact "Add to trade journal…". */
export const JOURNAL_PLACEHOLDERS: Readonly<Record<JournalKind, string>> = Object.freeze({
  NOTE: "Add to trade journal…",
  DECISION: "What did you decide, and why?",
  STOP_CHANGE: "Why move the stop? (optional)",
  TARGET_CHANGE: "Why move the target? (optional)",
  PARTIAL_CLOSE: "Why take a partial? (optional)",
  LESSON: "What will you do differently?",
});

/**
 * The composer's `timingHint` for a trade's lifecycle: where a note written now will most likely land.
 * Drafts, locked plans and skipped, cancelled or discarded trades have no entry (Before entry); a live
 * position (planned or live-first) is While live; closed and reviewed trades are After close. The server
 * still decides the real timing from its own clock.
 */
export function timingHintForLifecycle(lifecycle: Lifecycle): Timing {
  if (lifecycle === "LIVE") return "WHILE_LIVE";
  if (lifecycle === "CLOSED" || lifecycle === "REVIEWED") return "AFTER_CLOSE";
  return "BEFORE_ENTRY";
}

export type PartialAmount = "percent" | "quantity";

/** What the person typed; decimals stay strings end to end. */
export interface JournalDraft {
  kind: JournalKind;
  body: string;
  /** New stop or target price (required for Stop and Target), or the partial's exit price (optional). */
  price: string;
  /** Size or percent closed by a partial (optional), per `amountKind`. */
  amount: string;
  amountKind: PartialAmount;
}

export const EMPTY_JOURNAL_DRAFT: JournalDraft = Object.freeze({ kind: "NOTE", body: "", price: "", amount: "", amountKind: "percent" });

export type JournalField = "body" | "price" | "amount";
export type JournalFieldErrors = Partial<Record<JournalField, string>>;

/** One `addJournalEntry` call: `body` null when empty; `details` holds decimal strings only. */
export interface JournalEntryInput {
  kind: JournalKind;
  body: string | null;
  details: Record<string, string>;
}

export type JournalDraftCheck =
  /** `entry` null: nothing to write in the journal, only screenshots to save. */
  | { ok: true; entry: JournalEntryInput | null }
  | { ok: false; fieldErrors: JournalFieldErrors };

export const MAX_JOURNAL_BODY = 5000;

export const JOURNAL_COPY = Object.freeze({
  empty: "Write a note or attach a screenshot first.",
  decision: "Describe the decision first.",
  lesson: "Write the lesson first.",
  bodyTooLong: "Entries can be up to 5,000 characters.",
  stopRequired: "Enter the new stop price.",
  targetRequired: "Enter the new target price.",
  price: "Price must be a positive number with up to 8 decimals.",
  quantity: "Size must be a positive number with up to 8 decimals.",
  percent: "Percent must be more than 0 and less than 100.",
  partialEmpty: "Describe the partial close or give its price, size or percent.",
});

/** "Price must be a multiple of the 0.00001 tick size." */
export function tickCopy(tickSize: string): string {
  return `Price must be a multiple of the ${stripZeros(tickSize)} tick size.`;
}

const D = Decimal.clone({ precision: 60 });
/** `private.decimal_input`: 1–12 integer digits, up to 8 decimals, greater than zero. */
const POSITIVE = /^\d{1,12}(\.\d{1,8})?$/;
/** `check_journal_details`: 0 < percent < 100 with up to 8 decimals. */
const PERCENT = /^\d{1,2}(\.\d{1,8})?$/;

/** Trims spaces, tabs and line breaks at both ends, exactly like the database (`btrim(body, E' \t\r\n')`). */
export function trimJournalBody(body: string): string {
  return body.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

export function isPositiveDecimal(value: string): boolean {
  return POSITIVE.test(value) && new D(value).gt(0);
}

export function isPartialPercent(value: string): boolean {
  return PERCENT.test(value) && !new D(value).isZero();
}

/** True when `price` is a whole number of ticks; true as well when the tick size is unknown (the server decides). */
export function isTickAligned(price: string, tickSize: string | null | undefined): boolean {
  const tick = tickSize?.trim();
  if (!tick || !/^\d+(\.\d+)?$/.test(tick) || new D(tick).lte(0) || !/^\d+(\.\d+)?$/.test(price)) return true;
  return new D(price).mod(new D(tick)).isZero();
}

function checked(kind: JournalKind, body: string, details: Record<string, string>, errors: JournalFieldErrors): JournalDraftCheck {
  return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, entry: { kind, body: body || null, details } };
}

/**
 * Validates a draft like `add_journal_entry` does: Note, Decision and Lesson need text (a Note may be
 * empty when screenshots are attached, which then saves only the screenshots); Stop and Target need a
 * positive price on the instrument's tick; a Partial needs text or any of price, size or percent, with
 * 0 < percent < 100 and never both size and percent.
 */
export function validateJournalDraft(draft: JournalDraft, context: { tickSize?: string | null; screenshotCount?: number } = {}): JournalDraftCheck {
  const body = trimJournalBody(draft.body);
  const price = draft.price.trim();
  const amount = draft.amount.trim();
  const errors: JournalFieldErrors = {};
  if ([...body].length > MAX_JOURNAL_BODY) errors.body = JOURNAL_COPY.bodyTooLong;

  switch (draft.kind) {
    case "NOTE":
    case "DECISION":
    case "LESSON": {
      if (!body) {
        if (draft.kind === "NOTE" && (context.screenshotCount ?? 0) > 0) return { ok: true, entry: null };
        errors.body = draft.kind === "NOTE" ? JOURNAL_COPY.empty : draft.kind === "DECISION" ? JOURNAL_COPY.decision : JOURNAL_COPY.lesson;
      }
      return checked(draft.kind, body, {}, errors);
    }
    case "STOP_CHANGE":
    case "TARGET_CHANGE": {
      if (!price) errors.price = draft.kind === "STOP_CHANGE" ? JOURNAL_COPY.stopRequired : JOURNAL_COPY.targetRequired;
      else if (!isPositiveDecimal(price)) errors.price = JOURNAL_COPY.price;
      else if (!isTickAligned(price, context.tickSize)) errors.price = tickCopy(context.tickSize ?? "");
      return checked(draft.kind, body, { price }, errors);
    }
    case "PARTIAL_CLOSE": {
      const details: Record<string, string> = {};
      if (price) {
        if (isPositiveDecimal(price)) details.price = price;
        else errors.price = JOURNAL_COPY.price;
      }
      if (amount) {
        if (draft.amountKind === "percent") {
          if (isPartialPercent(amount)) details.percent = amount;
          else errors.amount = JOURNAL_COPY.percent;
        } else if (isPositiveDecimal(amount)) details.quantity = amount;
        else errors.amount = JOURNAL_COPY.quantity;
      }
      if (!body && !price && !amount) errors.body = JOURNAL_COPY.partialEmpty;
      return checked(draft.kind, body, details, errors);
    }
  }
}

/** FormData of `addJournalEntry` (§12.2): `tradeId`, `kind`, `body?`, `details?` (JSON object), `requestKey`. */
export function journalEntryForm(tradeId: string, requestKey: string, entry: JournalEntryInput): FormData {
  const form = new FormData();
  form.set("tradeId", tradeId);
  form.set("kind", entry.kind);
  form.set("requestKey", requestKey);
  if (entry.body !== null) form.set("body", entry.body);
  if (Object.keys(entry.details).length) form.set("details", JSON.stringify(entry.details));
  return form;
}

/**
 * Splits the action's field errors into the composer's fields and one general message (the action names
 * `quantity` and `percent` separately; the composer has one amount field).
 */
export function journalServerErrors(fieldErrors: Readonly<Record<string, string>> | undefined): { fieldErrors: JournalFieldErrors; general: string | null } {
  const mapped: JournalFieldErrors = {};
  let general: string | null = null;
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    if (key === "body" || key === "price") mapped[key] = message;
    else if (key === "quantity" || key === "percent") mapped.amount = message;
    else general ??= message;
  }
  return { fieldErrors: mapped, general };
}

const PREVIEW_TRADE: TimelineTrade = Object.freeze({
  id: "pending", origin: "PLANNED", created_at: "2000-01-01T00:00:00Z", currency: "USD", plan_id: null, locked_at: null, strategy_version: null,
  risk_plan_version: null, entered_at: null, entry_recorded_at: null, entry_price: null, quantity: null, planned_quantity: null, oversize: null,
  exited_at: null, close_recorded_at: null, exit_price: null, realized_r: null, net_pnl: null,
});

/** Title the timeline will give the entry ("Stop moved to 1.08500", "Partial close · 50% at 1.09000"), from the domain's own rules. */
export function journalEntryTitle(entry: JournalEntryInput, instrument?: { tickSize?: string | null; quantityStep?: string | null } | null): string {
  const [item] = buildTimeline({
    trade: PREVIEW_TRADE,
    instrument: instrument ?? null,
    journal: [{ id: "pending", kind: entry.kind, body: entry.body, details: entry.details, phase: "PRE_ENTRY", recordedAt: "2000-01-01T00:00:00Z" }],
  });
  return item?.title ?? JOURNAL_KIND_LABELS[entry.kind];
}
