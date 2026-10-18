"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { operationalFailure } from "@/lib/operational-log";
import {
  connectMockPlatform, disconnectPlatform, isMockSyncEnabled, type LinkResult, linkPlatformExecution, MOCK_CONNECTION_LABEL, MOCK_SYNC_UNAVAILABLE,
  simulateMockSync, unlinkPlatformExecution,
} from "@/lib/sync-service";

/**
 * Platform connection actions (spec §8.6). Mock connections and "Simulate sync" exist only when
 * TRADING_OS_ENABLE_MOCK_SYNC=true. The user always comes from the verified session inside
 * src/lib/sync-service.ts; nothing here accepts a user id from the client.
 */

export interface ConnectionActionState {
  error?: string;
  success?: string;
}

const FAILED = "The connection change could not be saved. Refresh and try again.";
const SYNC_FAILED = "The sync could not run. Refresh and try again.";

const uuid = z.uuid();
const createInput = z.object({
  accountId: uuid,
  label: z.string().trim().min(1).max(60),
  requestKey: uuid,
});
const linkInput = z.object({ tradeId: uuid, executionId: uuid });

function text(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function revalidateConnection(accountId: string, tradeIds: readonly string[] = []): void {
  revalidatePath("/settings");
  revalidatePath(`/accounts/${accountId}/manage`);
  for (const tradeId of tradeIds) revalidatePath(`/trades/${tradeId}`);
}

function unexpected(error: unknown, copy: string): ConnectionActionState {
  unstable_rethrow(error);
  operationalFailure("database_write_failed");
  return { error: copy };
}

export async function createMockConnection(_state: ConnectionActionState, form: FormData): Promise<ConnectionActionState> {
  try {
    if (!isMockSyncEnabled()) return { error: MOCK_SYNC_UNAVAILABLE };
    const input = createInput.safeParse({ accountId: text(form, "accountId"), label: text(form, "label") || MOCK_CONNECTION_LABEL, requestKey: text(form, "requestKey") });
    if (!input.success) return { error: "Choose a trading account and a label of up to 60 characters." };
    const result = await connectMockPlatform(input.data);
    if (!result.ok) return { error: result.error };
    revalidateConnection(input.data.accountId);
    return { success: "Mock platform connected. Use Simulate sync to import its sample positions." };
  } catch (error) {
    return unexpected(error, FAILED);
  }
}

export async function disconnectConnection(_state: ConnectionActionState, form: FormData): Promise<ConnectionActionState> {
  try {
    const connectionId = uuid.safeParse(text(form, "connectionId"));
    if (!connectionId.success) return { error: "That connection isn't available." };
    const result = await disconnectPlatform(connectionId.data);
    if (!result.ok) return { error: result.error };
    revalidateConnection(result.accountId);
    return { success: "Disconnected. Imported trades and their history are kept." };
  } catch (error) {
    return unexpected(error, FAILED);
  }
}

export async function runMockSync(_state: ConnectionActionState, form: FormData): Promise<ConnectionActionState> {
  try {
    if (!isMockSyncEnabled()) return { error: MOCK_SYNC_UNAVAILABLE };
    const connectionId = uuid.safeParse(text(form, "connectionId"));
    if (!connectionId.success) return { error: "That connection isn't available." };
    const result = await simulateMockSync(connectionId.data);
    if (!result.ok) return { error: result.error };
    // A run that stopped early keeps what it imported, so its trades are refreshed as well.
    revalidateConnection(result.accountId, result.tradeIds);
    return result.report.status === "SYNCED" ? { success: result.message } : { error: result.message };
  } catch (error) {
    return unexpected(error, SYNC_FAILED);
  }
}

async function changeLink(form: FormData, change: (tradeId: string, executionId: string) => Promise<LinkResult>, success: string): Promise<ConnectionActionState> {
  const input = linkInput.safeParse({ tradeId: text(form, "tradeId"), executionId: text(form, "executionId") });
  if (!input.success) return { error: "Choose a trade and a platform execution." };
  const result = await change(input.data.tradeId, input.data.executionId);
  if (!result.ok) return { error: result.error };
  revalidateConnection(result.accountId, [result.tradeId]);
  return { success };
}

export async function linkExecution(_state: ConnectionActionState, form: FormData): Promise<ConnectionActionState> {
  try {
    return await changeLink(form, linkPlatformExecution, "Platform execution linked to this trade.");
  } catch (error) {
    return unexpected(error, FAILED);
  }
}

export async function unlinkExecution(_state: ConnectionActionState, form: FormData): Promise<ConnectionActionState> {
  try {
    return await changeLink(form, unlinkPlatformExecution, "Platform execution unlinked. It is listed with the unmatched executions again.");
  } catch (error) {
    return unexpected(error, FAILED);
  }
}
