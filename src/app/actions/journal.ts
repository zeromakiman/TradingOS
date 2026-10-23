"use server";
import Decimal from "decimal.js";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { operationalFailure } from "@/lib/operational-log";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { type ActionState, actionError, actionSuccess, FAILED_COPY, formOptional, formText, INVALID_COPY, rpcErrorCopy } from "./state";

/**
 * Live trade journal (docs/V2_ARCHITECTURE.md §3.6, §12.2). Contract used by the shared composer:
 * `addJournalEntry` fields `tradeId`, `kind` (NOTE|DECISION|STOP_CHANGE|TARGET_CHANGE|PARTIAL_CLOSE|LESSON), `body?`,
 * `details?` (JSON object), `requestKey` → `data: { id }`. Phase and the lifecycle at creation are computed by the
 * database from server-side facts, never from the client. A retry with the same `requestKey` returns the same entry.
 */

const D = Decimal.clone({ precision: 60 });
const KINDS = ["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"] as const;
export type JournalKind = (typeof KINDS)[number];
const PRICE = /^\d{1,12}(\.\d{1,8})?$/;
const PERCENT = /^\d{1,2}(\.\d{1,8})?$/;

const COPY = {
  tradeId: "This trade isn't available. Reload the page.",
  requestKey: "Reload the page and submit the entry again.",
  kind: "Choose what kind of entry this is.",
  body: "Write the note (up to 5,000 characters).",
  details: "Check the price, size or percent of this entry.",
  price: "Price must be a positive number with up to 8 decimals.",
  quantity: "Size must be a positive number with up to 8 decimals.",
  percent: "Percent must be more than 0 and less than 100.",
} as const;

type Details = Record<string, string>;
type Checked = { ok: true; body: string | null; details: Details } | { ok: false; fieldErrors: Record<string, string> };

function positive(value: string): boolean {
  return PRICE.test(value) && new D(value).gt(0);
}

/** TypeScript mirror of private.check_journal_details: rejects what the database would reject, with field copy. */
function validateJournalEntry(kind: JournalKind, rawBody: string | undefined, rawDetails: string | undefined): Checked {
  const body = rawBody?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") || null;
  if (body !== null && [...body].length > 5000) return { ok: false, fieldErrors: { body: COPY.body } };
  let parsed: unknown = {};
  if (rawDetails?.trim()) {
    try {
      parsed = JSON.parse(rawDetails);
    } catch {
      return { ok: false, fieldErrors: { details: COPY.details } };
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, fieldErrors: { details: COPY.details } };
  const details: Details = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    // Decimals travel as JSON strings (the database rejects numbers, which lose precision).
    if (typeof value !== "string") return { ok: false, fieldErrors: { details: COPY.details } };
    details[key] = value.trim();
  }
  const keys = Object.keys(details);
  const errors: Record<string, string> = {};
  if (kind === "NOTE" || kind === "DECISION" || kind === "LESSON") {
    if (keys.length) errors.details = COPY.details;
    if (body === null) errors.body = COPY.body;
  } else if (kind === "STOP_CHANGE" || kind === "TARGET_CHANGE") {
    if (keys.some(key => key !== "price")) errors.details = COPY.details;
    if (!details.price || !positive(details.price)) errors.price = COPY.price;
  } else {
    if (keys.some(key => key !== "price" && key !== "quantity" && key !== "percent")) errors.details = COPY.details;
    if (details.price !== undefined && !positive(details.price)) errors.price = COPY.price;
    if (details.quantity !== undefined && !positive(details.quantity)) errors.quantity = COPY.quantity;
    if (details.percent !== undefined && (!PERCENT.test(details.percent) || new D(details.percent).isZero())) errors.percent = COPY.percent;
    if (details.quantity !== undefined && details.percent !== undefined) errors.details = "Give either the size or the percent of a partial close, not both.";
    if (body === null && keys.length === 0) errors.body = "Describe the partial close or give its price, size or percent.";
  }
  return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, body, details };
}

const input = z.object({ tradeId: z.uuid(), kind: z.enum(KINDS), requestKey: z.uuid() });

export async function addJournalEntry(_prev: ActionState<{ id: string }>, form: FormData): Promise<ActionState<{ id: string }>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const ids = input.safeParse({ tradeId: formText(form, "tradeId"), kind: formText(form, "kind"), requestKey: formText(form, "requestKey") });
    if (!ids.success) {
      const errors: Record<string, string> = {};
      for (const issue of ids.error.issues) {
        const key = String(issue.path[0]) as "tradeId" | "kind" | "requestKey";
        errors[key] = COPY[key];
      }
      return actionError(INVALID_COPY, errors);
    }
    const checked = validateJournalEntry(ids.data.kind, formText(form, "body"), formOptional(form, "details"));
    if (!checked.ok) return actionError(INVALID_COPY, checked.fieldErrors);
    const { data, error } = await session.db.rpc("add_journal_entry", {
      p_trade_id: ids.data.tradeId, p_kind: ids.data.kind, p_body: checked.body, p_details: checked.details, p_request_key: ids.data.requestKey,
    });
    if (error) {
      const message = rpcErrorCopy(error, { INVALID_INPUT: "The entry was not accepted. Prices must match the instrument's tick size." });
      if (message === FAILED_COPY) operationalFailure("database_write_failed");
      return actionError(message);
    }
    const id = z.uuid().parse(data);
    revalidatePath(`/trades/${ids.data.tradeId}`);
    revalidatePath("/today");
    return actionSuccess("Added to the journal.", { id });
  } catch (error) {
    unstable_rethrow(error);
    operationalFailure("database_write_failed");
    return actionError(FAILED_COPY);
  }
}
