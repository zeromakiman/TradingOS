import "server-only";
import { z } from "zod";
import type { Db } from "./account-context";
import { trustedServer } from "./supabase/admin";

/**
 * Storage cleanup after a permanent trade deletion or a trading-account deletion (0020). The deletion's own transaction
 * records every object of what it deleted, and every folder to sweep for orphans of failed uploads, in
 * `storage_cleanup_queue`. This drain removes them with the trusted server (secret key) and then deletes exactly the
 * rows whose objects are gone (`complete_storage_cleanup`, service role only). A row whose removal failed stays and is
 * retried by the next deletion or by "Retry cleanup" on Deleted trades, so nothing is silently left behind. The
 * objects stay unreadable meanwhile (storage RLS needs the deleted rows). Never logs paths or ids.
 */

const BUCKETS = ["setup-screenshots", "trade-evidence"] as const;
type BucketName = (typeof BUCKETS)[number];
/** Rows handled per drain; a larger backlog is drained by the next call. */
const DRAIN_ROWS = 500;
const REMOVE_BATCH = 100;
const LIST_PAGE = 100;
const MAX_SWEEP_ROUNDS = 5;

/** Added to a deletion's success message while queued files are still waiting to be removed. */
export const STORAGE_PENDING_NOTE = "Some screenshot files are still being removed from storage (unreadable meanwhile); Deleted trades can retry it.";

/** The storage paths a deletion RPC returns (kept in its result; the queue is what the drain reads). */
export const deletionStorageSchema = z.object({
  legacy: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
});

const queueRow = z.object({ id: z.number().int().positive(), bucket: z.enum(BUCKETS), kind: z.enum(["OBJECT", "PREFIX"]), path: z.string().min(1) });
type QueueRow = z.output<typeof queueRow>;

interface Bucket {
  list(path: string, options: { limit: number; offset: number }): Promise<{ data: readonly { name: string; id: string | null }[] | null; error: unknown }>;
  remove(paths: string[]): Promise<{ error: unknown }>;
}

/** The trusted-server side of the drain; tests pass fakes. */
export interface CleanupServices {
  bucket(name: BucketName): Bucket;
  complete(userId: string, ids: readonly number[]): Promise<boolean>;
}

function trustedCleanupServices(): CleanupServices {
  const trusted = trustedServer();
  return {
    bucket: name => trusted.storage.from(name) as unknown as Bucket,
    async complete(userId, ids) {
      const { error } = await trusted.rpc("complete_storage_cleanup", { p_user_id: userId, p_ids: ids });
      return !error;
    },
  };
}

/** Only the user's own folder: a queued path never reaches another user's objects. */
function owned(userId: string, path: string): boolean {
  return path.startsWith(`${userId}/`) && !path.includes("..");
}

/** Removes every object directly below `{prefix}/` (objects are `{user}/{trade or proposal}/{id}`). */
async function sweep(bucket: Bucket, prefix: string): Promise<boolean> {
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, offset: 0 });
    if (error || !data) return false;
    const objects = data.filter(entry => entry.id !== null && entry.name !== "" && !entry.name.includes("/")).map(entry => `${prefix}/${entry.name}`);
    if (objects.length === 0) return true;
    const removed = await bucket.remove(objects);
    if (removed.error) return false;
  }
  return false;
}

/** The ids of the rows whose objects are gone. */
async function removeRows(services: CleanupServices, rows: readonly QueueRow[]): Promise<number[]> {
  const done: number[] = [];
  for (const name of BUCKETS) {
    const bucket = services.bucket(name);
    const objects = rows.filter(row => row.bucket === name && row.kind === "OBJECT");
    for (let start = 0; start < objects.length; start += REMOVE_BATCH) {
      const batch = objects.slice(start, start + REMOVE_BATCH);
      const { error } = await bucket.remove(batch.map(row => row.path));
      if (!error) done.push(...batch.map(row => row.id));
    }
    for (const row of rows.filter(entry => entry.bucket === name && entry.kind === "PREFIX")) {
      if (await sweep(bucket, row.path)) done.push(row.id);
    }
  }
  return done;
}

/** How many cleanup rows of the user are still waiting (the user's session; RLS shows only their own rows). */
export async function pendingStorageCleanup(db: Db, userId: string): Promise<number> {
  const { count, error } = await db.from("storage_cleanup_queue").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if (error) throw new Error("Storage cleanup status is unavailable.");
  return z.number().int().nonnegative().parse(count);
}

/**
 * Drains the user's cleanup queue: removes the queued objects, sweeps the queued folders, and completes the rows that
 * succeeded. Resolves with the number of rows still waiting (0 when everything was removed).
 */
export async function drainStorageCleanup(db: Db, userId: string, services: CleanupServices = trustedCleanupServices()): Promise<number> {
  const { data, error } = await db.from("storage_cleanup_queue").select("id,bucket,kind,path").eq("user_id", userId).order("id").limit(DRAIN_ROWS);
  if (error) throw new Error("Storage cleanup is unavailable.");
  const rows = z.array(queueRow).parse(data ?? []).filter(row => owned(userId, row.path));
  const done = rows.length ? await removeRows(services, rows) : [];
  if (done.length && !(await services.complete(userId, done))) throw new Error("Storage cleanup could not be recorded.");
  return pendingStorageCleanup(db, userId);
}
