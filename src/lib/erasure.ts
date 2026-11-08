import "server-only";
import { createClient, isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { trustedServer } from "./supabase/admin";
import { publicConfig } from "./supabase/config";

/**
 * Delete Trading OS account (docs/V2_ARCHITECTURE.md §10.4). Every step is idempotent, so a retry after any failure
 * converges: the purge of an already-empty account deletes nothing, removing missing storage objects is a no-op,
 * the prefix sweep catches objects whose rows are already gone, and an already-deleted auth user counts as deleted.
 *
 *   1. typed DELETE + password re-entry: a fresh sign-in through a client that never stores or refreshes its session.
 *      It must sign in the session user itself, and it is signed out again before anything is deleted: it only
 *      proves the password;
 *   2. purge_user_trading_data for the session user through the trusted server (secret key). One transaction; it
 *      refuses while AI is in flight. Only the service role can execute it: no access token of a user, however fresh
 *      its password sign-in (a browser's own login looks exactly like a re-authentication), can call any purge RPC,
 *      so the typed DELETE and the password re-entry cannot be skipped;
 *   3. the trusted server deletes the returned storage paths, then sweeps `{uid}/` in both buckets until empty;
 *   4. global sign-out, then the auth user is deleted. The server action clears cookies and redirects.
 *
 * The auth user is deleted last: until then a failed run leaves an account that can sign in and simply retry.
 */

/** Sent to the purge RPC only after step 1 succeeded; must equal the constant in 0019_account_erasure.sql. */
export const ERASE_CONFIRMATION_PHRASE = "ERASE ALL MY TRADING OS DATA";
/** What the user types in Settings → Danger zone. */
export const DELETE_CONFIRMATION_WORD = "DELETE";
/** Private buckets that hold Trading OS objects under `{user_id}/`. */
export const ERASURE_BUCKETS = ["setup-screenshots", "trade-evidence"] as const;
export type ErasureBucket = (typeof ERASURE_BUCKETS)[number];

export const ERASURE_COPY = {
  confirmationRequired: "Type DELETE in capital letters to confirm.",
  passwordRequired: "Enter your current password to confirm.",
  passwordRejected: "That password is not correct. Nothing was deleted.",
  signInUnavailable: "The sign-in service is temporarily unavailable. Nothing was deleted. Please try again.",
  aiInProgress: "An AI request for your account is still running. Nothing was deleted. Try again once it has finished (at most 30 minutes).",
  incomplete: "Deletion did not finish. Nothing was shared, and you can safely try again: completed steps are skipped.",
} as const;

/** Fixed operational events. The user id, email, password, storage paths and error texts are never logged. */
export type ErasureEvent =
  | "erasure_reauth_rejected"
  | "erasure_reauth_unavailable"
  | "erasure_purge_refused"
  | "erasure_purge_failed"
  | "erasure_storage_failed"
  | "erasure_sign_out_failed"
  | "erasure_delete_user_failed"
  | "erasure_failed"
  | "erasure_completed";

export function erasureLog(event: ErasureEvent): void {
  const line = JSON.stringify({ event });
  if (event === "erasure_completed") console.info(line);
  else console.error(line);
}

interface ClientError {
  message: string;
  status?: number;
  code?: string;
}
type ClientResult = Promise<{ error: ClientError | null }>;

/** The part of a Storage bucket API the erasure uses (structurally satisfied by supabase-js `storage.from()`). */
export interface ErasureStorageBucket {
  list(path: string, options: { limit: number; offset: number; sortBy: { column: string; order: string } }):
    Promise<{ data: readonly { name: string; id: string | null }[] | null; error: ClientError | null }>;
  remove(paths: string[]): ClientResult;
}

export type PasswordCheck = "VALID" | "REJECTED" | "UNAVAILABLE";

/** VALID names the user the typed password signed in; the erasure goes on only when that is the session user. */
export type Reauthentication = { check: "VALID"; userId: string } | { check: Exclude<PasswordCheck, "VALID"> };

export interface ErasureServices {
  /**
   * Signs in again with the typed password through a client that never stores or refreshes its session, and signs
   * that session out before it resolves: the sign-in only proves the password, it never calls the database.
   */
  reauthenticate(email: string, password: string): Promise<Reauthentication>;
  /** Trusted server (secret key): purge_user_trading_data for one user, the only caller that can execute it. */
  purge(userId: string, confirmation: string): Promise<{ data: unknown; error: ClientError | null }>;
  /** Trusted server (secret key) access to one private bucket. */
  bucket(name: ErasureBucket): ErasureStorageBucket;
  /** Revokes every session of the user. */
  signOutEverywhere(): ClientResult;
  /** Trusted server (secret key): deletes the auth user. */
  deleteUser(userId: string): ClientResult;
}

export interface ErasureRequest {
  userId: string;
  email: string | null;
  confirmation: string;
  password: string;
}

export type ErasureOutcome = { ok: true } | { ok: false; error: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBJECT_PATH = new RegExp(`^(${UUID})/${UUID}/${UUID}$`);
const MAX_PASSWORD_LENGTH = 1024;
const REMOVE_BATCH = 100;
const LIST_PAGE = 100;
const MAX_FOLDER_DEPTH = 4;
const MAX_SWEEP_ROUNDS = 5;

/** The purge result. Every storage path must lie under the erased user's own `{uid}/` prefix. */
export function purgeResultSchema(userId: string) {
  const ownPath = z.string().refine((path) => OBJECT_PATH.exec(path)?.[1] === userId, "Storage path outside the user's prefix.");
  return z.object({
    storagePaths: z.object({ legacy: z.array(ownPath), evidence: z.array(ownPath) }).strict(),
    deleted: z.record(z.string(), z.number().int().nonnegative()),
  }).strict();
}
export type PurgeResult = z.output<ReturnType<typeof purgeResultSchema>>;

/** Copy for a form that must not reach any service yet, or null when the typed values may proceed. */
export function erasureInputError(confirmation: string, password: string): string | null {
  if (confirmation !== DELETE_CONFIRMATION_WORD) return ERASURE_COPY.confirmationRequired;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return ERASURE_COPY.passwordRequired;
  return null;
}

class ErasureStepError extends Error {
  constructor(readonly event: ErasureEvent) {
    super(event);
  }
}

export async function eraseTradingOsAccount(
  request: ErasureRequest,
  services: ErasureServices,
  log: (event: ErasureEvent) => void = erasureLog,
): Promise<ErasureOutcome> {
  const invalid = erasureInputError(request.confirmation, request.password);
  if (invalid) return { ok: false, error: invalid };
  try {
    await reauthenticate(request, services);
    const storagePaths = await purgeTradingData(request.userId, services);
    await step("erasure_storage_failed", () => deleteStorage(services, request.userId, storagePaths));
    // Deleting the auth user ends every session as well, so a failed revocation alone does not stop the erasure.
    const signOut = await services.signOutEverywhere().catch(() => ({ error: { message: "Sign-out failed." } }));
    if (signOut.error) log("erasure_sign_out_failed");
    const deleted = await step("erasure_delete_user_failed", () => services.deleteUser(request.userId));
    if (deleted.error && !userAlreadyDeleted(deleted.error)) throw new ErasureStepError("erasure_delete_user_failed");
  } catch (error) {
    const event = error instanceof ErasureStepError ? error.event : "erasure_failed";
    log(event);
    return { ok: false, error: copyFor(event) };
  }
  log("erasure_completed");
  return { ok: true };
}

function userAlreadyDeleted(error: ClientError): boolean {
  return error.status === 404 || error.code === "user_not_found";
}

const EVENT_COPY: Partial<Record<ErasureEvent, string>> = {
  erasure_reauth_rejected: ERASURE_COPY.passwordRejected,
  erasure_reauth_unavailable: ERASURE_COPY.signInUnavailable,
  erasure_purge_refused: ERASURE_COPY.aiInProgress,
};

function copyFor(event: ErasureEvent): string {
  return EVENT_COPY[event] ?? ERASURE_COPY.incomplete;
}

/** Runs one step, attributing an unexpected throw to that step's fixed event. */
async function step<T>(event: ErasureEvent, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof ErasureStepError ? error : new ErasureStepError(event);
  }
}

/** The typed password must sign in the session user itself; only then may anything be deleted. */
async function reauthenticate(request: ErasureRequest, services: ErasureServices): Promise<void> {
  const email = request.email;
  // Every Trading OS login is an email/password account; anything else cannot be re-authenticated here.
  if (!email) throw new ErasureStepError("erasure_failed");
  const result = await step("erasure_reauth_unavailable", () => services.reauthenticate(email, request.password));
  if (result.check !== "VALID") {
    throw new ErasureStepError(result.check === "REJECTED" ? "erasure_reauth_rejected" : "erasure_reauth_unavailable");
  }
  // The password of another account never erases this one.
  if (result.userId !== request.userId) throw new ErasureStepError("erasure_reauth_rejected");
}

/** Fixed events for the purge's stable error prefixes (0019_account_erasure.sql). */
function purgeErrorEvent(message: string): ErasureEvent {
  return message.startsWith("AI_REQUEST_IN_PROGRESS:") ? "erasure_purge_refused" : "erasure_purge_failed";
}

/** Purges the re-authenticated session user through the trusted server. */
async function purgeTradingData(userId: string, services: ErasureServices): Promise<PurgeResult["storagePaths"]> {
  const result = await step("erasure_purge_failed", () => services.purge(userId, ERASE_CONFIRMATION_PHRASE));
  if (result.error) throw new ErasureStepError(purgeErrorEvent(result.error.message));
  const parsed = purgeResultSchema(userId).safeParse(result.data);
  if (!parsed.success) throw new ErasureStepError("erasure_purge_failed");
  return parsed.data.storagePaths;
}

async function deleteStorage(services: ErasureServices, userId: string, paths: PurgeResult["storagePaths"]): Promise<void> {
  const registered: Record<ErasureBucket, readonly string[]> = { "setup-screenshots": paths.legacy, "trade-evidence": paths.evidence };
  for (const name of ERASURE_BUCKETS) {
    const bucket = services.bucket(name);
    await removeObjects(bucket, registered[name]);
    await sweepPrefix(bucket, userId);
  }
}

async function removeObjects(bucket: ErasureStorageBucket, paths: readonly string[]): Promise<void> {
  for (let start = 0; start < paths.length; start += REMOVE_BATCH) {
    const { error } = await bucket.remove(paths.slice(start, start + REMOVE_BATCH));
    if (error) throw new ErasureStepError("erasure_storage_failed");
  }
}

/** Deletes everything left under `{prefix}/` (orphans of failed uploads or cleanups) until a listing comes back empty. */
async function sweepPrefix(bucket: ErasureStorageBucket, prefix: string): Promise<void> {
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    const objects = await listObjects(bucket, prefix);
    if (objects.length === 0) return;
    await removeObjects(bucket, objects);
  }
  throw new ErasureStepError("erasure_storage_failed");
}

/** Every object below `prefix`, folder by folder: Storage lists one level at a time and marks folders with a null id. */
async function listObjects(bucket: ErasureStorageBucket, prefix: string): Promise<string[]> {
  const objects: string[] = [];
  const folders = [{ path: prefix, depth: 0 }];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await bucket.list(folder.path, { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error || !data) throw new ErasureStepError("erasure_storage_failed");
      for (const entry of data) {
        if (entry.name === "" || entry.name === "." || entry.name === ".." || entry.name.includes("/")) {
          throw new ErasureStepError("erasure_storage_failed");
        }
        const path = `${folder.path}/${entry.name}`;
        if (entry.id !== null) objects.push(path);
        else if (folder.depth < MAX_FOLDER_DEPTH) folders.push({ path, depth: folder.depth + 1 });
        else throw new ErasureStepError("erasure_storage_failed");
      }
      if (data.length < LIST_PAGE) break;
    }
  }
  return objects;
}

/**
 * Real services for the signed-in user (`session` is the cookie session; it only signs out everywhere). The trusted
 * client is created first, so a missing secret key fails before anything is deleted (a purge whose storage step
 * could never run would leave the account half-erased).
 */
export function supabaseErasureServices(session: SupabaseClient): ErasureServices {
  const config = publicConfig();
  if (!config) throw new Error("Supabase has not been configured.");
  const trusted = trustedServer();
  return {
    async reauthenticate(email, password) {
      const verifier = createClient(config.url, config.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await verifier.auth.signInWithPassword({ email, password });
      if (error) {
        return { check: isAuthRetryableFetchError(error) || error.status === 429 || (error.status ?? 0) >= 500 ? "UNAVAILABLE" : "REJECTED" };
      }
      // The new session is ended at once, before anything is deleted. Best effort: it never left this process, and the
      // global sign-out after the purge revokes it as well.
      await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);
      return data.user?.id ? { check: "VALID", userId: data.user.id } : { check: "REJECTED" };
    },
    async purge(userId, confirmation) {
      const result = await trusted.rpc("purge_user_trading_data", { p_user_id: userId, p_confirm: confirmation });
      return { data: result.data, error: result.error };
    },
    bucket: (name) => trusted.storage.from(name),
    signOutEverywhere: () => session.auth.signOut({ scope: "global" }),
    deleteUser: (id) => trusted.auth.admin.deleteUser(id),
  };
}
