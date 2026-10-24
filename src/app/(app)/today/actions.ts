"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { type ActionState, actionError, actionSuccess, FAILED_COPY, formText, INVALID_COPY, rpcErrorCopy } from "@/app/actions/state";
import { NOTES_ARCHIVED_COPY, NOTES_MAX_LENGTH, NOTES_SAVED_COPY } from "@/components/today/copy";
import { loadAccount } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";

/**
 * Today's plan · notes (docs/V2_ARCHITECTURE.md §14.1): the V1 daily context, saved through `save_daily_context` as a
 * new revision of the account's notes for the current strategy day (the database decides the day from its own clock).
 * Follows the V2 action convention (§12.2): schema gate first, validation with field copy, one RPC with the user's
 * session, revalidation of Today, human copy only.
 *
 * Form fields: `accountId`, `narrative` (up to 20,000 characters; empty clears today's notes).
 */

const NOTES_COPY = {
  accountId: "This trading account isn't available. Reload the page.",
  narrative: `Keep today's plan to ${NOTES_MAX_LENGTH.toLocaleString("en-US")} characters.`,
} as const;

const input = z.object({
  accountId: z.uuid(),
  // The database counts characters (code points), not UTF-16 units.
  narrative: z.string().refine(text => [...text].length <= NOTES_MAX_LENGTH),
});

export async function saveDailyContext(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    // Browsers submit a textarea's line breaks as CRLF; the notes are stored with plain line feeds.
    const narrative = (formText(form, "narrative") ?? "").replace(/\r\n?/g, "\n");
    const parsed = input.safeParse({ accountId: formText(form, "accountId")?.trim().toLowerCase(), narrative });
    if (!parsed.success) {
      const field = parsed.error.issues.some(issue => issue.path[0] === "accountId") ? "accountId" : "narrative";
      return actionError(INVALID_COPY, { [field]: NOTES_COPY[field] });
    }
    const account = await loadAccount(session.db, session.user.id, parsed.data.accountId);
    if (!account) return actionError(NOTES_COPY.accountId, { accountId: NOTES_COPY.accountId });
    if (account.status === "ARCHIVED") return actionError(NOTES_ARCHIVED_COPY, { accountId: NOTES_ARCHIVED_COPY });
    const { error } = await session.db.rpc("save_daily_context", { p_account_id: account.id, p_narrative: parsed.data.narrative });
    if (error) {
      const message = rpcErrorCopy(error);
      if (message === FAILED_COPY) operationalFailure("database_write_failed");
      return actionError(message);
    }
    revalidatePath("/today");
    return actionSuccess(NOTES_SAVED_COPY);
  } catch (error) {
    unstable_rethrow(error);
    operationalFailure("database_write_failed");
    return actionError(FAILED_COPY);
  }
}
