"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { operationalFailure } from "@/lib/operational-log";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { type ActionState, actionError, actionSuccess, FAILED_COPY, formText, INVALID_COPY, rpcErrorCopy, type RpcErrorLike } from "./state";

/**
 * Custom model actions (0020): Manage → Models creates, renames, archives, restores and removes the account's custom
 * models; Record Live Trade adds one inline; a live-first or imported trade sets or changes its model. Schema gate
 * first, zod validation, one RPC with the user's session (the database checks ownership, name uniqueness and the
 * trade's entry model), then revalidation.
 *
 * Form contracts:
 * - createCustomModel: accountId, requestKey, name, description? → { modelId, name }
 * - renameCustomModel: modelId, name, description? · archiveCustomModel / restoreCustomModel / removeCustomModel: modelId
 * - setTradeCustomModel: tradeId, modelId? (empty clears it)
 */

const uuid = z.uuid();
const name = z.string().trim().min(1).max(60);
const description = z.string().trim().max(500).optional();

const MODEL_COPY: Readonly<Record<string, string>> = Object.freeze({
  MODEL_NAME_TAKEN: "This account already has a model with that name (OB first touch, OTE and Other are the Risk Engine's own models).",
  MODEL_IN_USE: "This model is recorded on a trade, so it can only be archived.",
  MODEL_NOT_FOUND: "That model isn't available. Reload the page.",
  MODEL_NOT_AVAILABLE: "Choose an active model of this trade's account.",
  MODEL_NOT_APPLICABLE: "Only live-first and imported trades recorded with Other or no model can take a custom model.",
});

const FIELD_COPY = {
  accountId: "This trading account isn't available. Reload the page.",
  modelId: "That model isn't available. Reload the page.",
  tradeId: "This trade isn't available. Reload the page.",
  requestKey: "Reload the page and submit the form again.",
  name: "Name the model (1 to 60 characters).",
  description: "Keep the description to 500 characters.",
} as const;

function failure<T>(error: RpcErrorLike): ActionState<T> {
  const message = rpcErrorCopy(error, MODEL_COPY);
  if (message === FAILED_COPY) operationalFailure("database_write_failed");
  return actionError(message, message === MODEL_COPY.MODEL_NAME_TAKEN ? { name: message } : undefined);
}

function unexpected<T>(error: unknown): ActionState<T> {
  unstable_rethrow(error);
  operationalFailure("database_write_failed");
  return actionError(FAILED_COPY);
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "name");
    errors[key] = Object.hasOwn(FIELD_COPY, key) ? FIELD_COPY[key as keyof typeof FIELD_COPY] : FIELD_COPY.name;
  }
  return errors;
}

function revalidateModels(): void {
  revalidatePath("/accounts", "layout");
  revalidatePath("/trades/live/new");
  revalidatePath("/journal");
  revalidatePath("/edge");
}

const createInput = z.object({ accountId: uuid, requestKey: uuid, name, description });

export async function createCustomModel(_prev: ActionState<{ modelId: string; name: string }>, form: FormData): Promise<ActionState<{ modelId: string; name: string }>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = createInput.safeParse({
      accountId: formText(form, "accountId")?.toLowerCase(), requestKey: formText(form, "requestKey"), name: formText(form, "name"),
      description: formText(form, "description")?.trim() || undefined,
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error));
    const { data, error } = await session.db.rpc("create_custom_model", {
      p_account_id: input.data.accountId, p_input: { name: input.data.name, ...(input.data.description ? { description: input.data.description } : {}) },
      p_request_key: input.data.requestKey,
    });
    if (error) return failure(error);
    const modelId = z.object({ modelId: z.uuid() }).parse(data).modelId;
    revalidateModels();
    return actionSuccess("Model added. It is a journal label: the Risk Engine validates OB first touch and OTE only.", { modelId, name: input.data.name });
  } catch (error) {
    return unexpected(error);
  }
}

type Change = { ok: true; input: Record<string, string> } | { ok: false; errors: Record<string, string> };

async function revise(form: FormData, change: (form: FormData) => Change, message: string): Promise<ActionState> {
  const session = await writableSession();
  if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
  const modelId = uuid.safeParse(formText(form, "modelId")?.toLowerCase());
  if (!modelId.success) return actionError(INVALID_COPY, { modelId: FIELD_COPY.modelId });
  const input = change(form);
  if (!input.ok) return actionError(INVALID_COPY, input.errors);
  const { error } = await session.db.rpc("revise_custom_model", { p_model_id: modelId.data, p_input: input.input });
  if (error) return failure(error);
  revalidateModels();
  return actionSuccess(message);
}

export async function renameCustomModel(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    return await revise(form, values => {
      const parsed = z.object({ name, description }).safeParse({ name: formText(values, "name"), description: formText(values, "description") });
      if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
      return { ok: true, input: { name: parsed.data.name, ...(parsed.data.description ? { description: parsed.data.description } : {}) } };
    }, "Model saved. Trades recorded with it show the new name.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function archiveCustomModel(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    return await revise(form, () => ({ ok: true, input: { status: "ARCHIVED" } }), "Model archived. It leaves the pickers and stays on its trades.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function restoreCustomModel(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    return await revise(form, () => ({ ok: true, input: { status: "ACTIVE" } }), "Model restored. It is back in the pickers.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function removeCustomModel(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const modelId = uuid.safeParse(formText(form, "modelId")?.toLowerCase());
    if (!modelId.success) return actionError(INVALID_COPY, { modelId: FIELD_COPY.modelId });
    const { error } = await session.db.rpc("delete_custom_model", { p_model_id: modelId.data });
    if (error) return failure(error);
    revalidateModels();
    return actionSuccess("Model removed.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function setTradeCustomModel(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const tradeId = uuid.safeParse(formText(form, "tradeId")?.toLowerCase());
    const raw = formText(form, "modelId")?.trim().toLowerCase() ?? "";
    const modelId = raw === "" ? null : uuid.safeParse(raw);
    if (!tradeId.success) return actionError(INVALID_COPY, { tradeId: FIELD_COPY.tradeId });
    if (modelId !== null && !modelId.success) return actionError(INVALID_COPY, { modelId: FIELD_COPY.modelId });
    const { error } = await session.db.rpc("set_trade_custom_model", { p_trade_id: tradeId.data, p_model_id: modelId === null ? null : modelId.data });
    if (error) return failure(error);
    revalidatePath(`/trades/${tradeId.data}`);
    revalidatePath("/today");
    revalidatePath("/journal");
    revalidatePath("/edge");
    return actionSuccess(modelId === null ? "Custom model cleared." : "Model saved on the trade.");
  } catch (error) {
    return unexpected(error);
  }
}
